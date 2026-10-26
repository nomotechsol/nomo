import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { type Candidate, type Chain, type FilterSet, type Holder, allocateExactly, candidateKey, disabledFilters } from "./domain.js";

export type CandidateState = "detected" | "rejected" | "eligible" | "needs_data" | "reserved" | "settled";
export type CandidateRow = {
  id: string;
  candidate: Candidate;
  state: CandidateState;
  reasons: string[];
  observedAt: number;
};
export type RoundInput = {
  candidateId: string;
  purchaseTx: string;
  receivedAtoms: bigint;
  rewardDecimals: number;
  snapshotSlot: number;
  holders: Holder[];
};
export type RoundRow = { candidateId: string; purchaseTx: string; receivedAtoms: string; rewardDecimals: number; snapshotSlot: number; createdAt: number };
export type TokenMetadata = { name: string | null; symbol: string | null; imageUrl: string | null; fetchedAt: number; expiresAt: number };
export type PurchaseRow = { candidateId: string; chain: Chain; launchpad: Candidate["launchpad"]; token: string;
  name: string | null; symbol: string | null; imageUrl: string | null; purchaseTx: string;
  spendAtoms: string | null; budgetLamports: string | null; createdAt: number };
export type PurchaseTotals = { count: number; solBudgetLamports: string | null;
  chains: Record<Chain, { count: number; spendAtoms: string | null }> };

function nonnegativeAtoms(value: unknown): string | null {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? value : null;
}

/** Durable monitoring and execution journal. No signing key is stored. */
export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        chain TEXT NOT NULL,
        token TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        state TEXT NOT NULL,
        reasons_json TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        UNIQUE(chain, token)
      );
      CREATE TABLE IF NOT EXISTS token_metadata (
        chain TEXT NOT NULL,
        token TEXT NOT NULL,
        name TEXT,
        symbol TEXT,
        image_url TEXT,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (chain, token)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_reserved_purchase ON candidates(state) WHERE state = 'reserved';
      CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, height TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS solana_events (
        signature TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        observed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rounds (
        candidate_id TEXT PRIMARY KEY REFERENCES candidates(id),
        purchase_tx TEXT NOT NULL UNIQUE,
        received_atoms TEXT NOT NULL,
        reward_decimals INTEGER NOT NULL DEFAULT 0,
        snapshot_slot INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS allocations (
        candidate_id TEXT NOT NULL REFERENCES rounds(candidate_id),
        sol_wallet TEXT NOT NULL,
        reward_atoms TEXT NOT NULL,
        PRIMARY KEY(candidate_id, sol_wallet)
      );
      CREATE TABLE IF NOT EXISTS link_challenges (
        id TEXT PRIMARY KEY,
        sol_wallet TEXT NOT NULL,
        evm_wallet TEXT NOT NULL,
        message TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS wallet_links (
        sol_wallet TEXT PRIMARY KEY,
        evm_wallet TEXT NOT NULL,
        linked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_jobs (
        candidate_id TEXT PRIMARY KEY REFERENCES candidates(id),
        stage TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS published_rounds (
        candidate_id TEXT PRIMARY KEY REFERENCES rounds(candidate_id),
        root TEXT NOT NULL,
        publish_tx TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        claim_target TEXT,
        chain_id INTEGER,
        delivery_mode TEXT NOT NULL DEFAULT 'claim'
      );
      CREATE TABLE IF NOT EXISTS solana_payout_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL REFERENCES published_rounds(candidate_id),
        state TEXT NOT NULL CHECK(state IN ('pending', 'sent')),
        signature TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS solana_payouts (
        candidate_id TEXT NOT NULL REFERENCES published_rounds(candidate_id),
        sol_wallet TEXT NOT NULL,
        reward_atoms TEXT NOT NULL,
        batch_id INTEGER REFERENCES solana_payout_batches(id),
        state TEXT NOT NULL CHECK(state IN ('pending', 'batched', 'sent')),
        signature TEXT,
        sent_at INTEGER,
        PRIMARY KEY(candidate_id, sol_wallet)
      );
      CREATE INDEX IF NOT EXISTS solana_payouts_pending ON solana_payouts(state, candidate_id);
      CREATE TABLE IF NOT EXISTS solana_claims (
        candidate_id TEXT NOT NULL REFERENCES published_rounds(candidate_id),
        sol_wallet TEXT NOT NULL,
        transaction_base64 TEXT NOT NULL,
        signature TEXT NOT NULL,
        last_valid_block_height INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared', 'claimed')),
        claimed_at INTEGER,
        PRIMARY KEY(candidate_id, sol_wallet)
      );
    `);
    const columns = this.db.pragma("table_info(rounds)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "reward_decimals"))
      this.db.exec("ALTER TABLE rounds ADD COLUMN reward_decimals INTEGER NOT NULL DEFAULT 0");
    const publishColumns = this.db.pragma("table_info(published_rounds)") as Array<{ name: string }>;
    if (!publishColumns.some((column) => column.name === "claim_target"))
      this.db.exec("ALTER TABLE published_rounds ADD COLUMN claim_target TEXT");
    if (!publishColumns.some((column) => column.name === "chain_id"))
      this.db.exec("ALTER TABLE published_rounds ADD COLUMN chain_id INTEGER");
    if (!publishColumns.some((column) => column.name === "delivery_mode"))
      this.db.exec("ALTER TABLE published_rounds ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'claim'");
    // Earlier RH fee USD estimates assumed every Pons pair was denominated in ETH.
    // Drop those cached estimates once so only quote-asset-aware GMGN data can qualify.
    if (!this.db.prepare("SELECT 1 FROM settings WHERE key = 'rh_fee_quote_asset_v1'").get()) {
      this.db.transaction(() => {
        this.db.prepare(`UPDATE candidates
          SET candidate_json = json_remove(candidate_json, '$.totalFeesUsd', '$.feeMetricsAt')
          WHERE chain = 'robinhood' AND state NOT IN ('reserved', 'settled')`).run();
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('rh_fee_quote_asset_v1', 'done')").run();
      })();
    }
    // RH filters use GMGN's native ETH Total Fees directly, like SOL and BNB.
    // Discard USD estimates made under the older pair-asset conversion.
    if (!this.db.prepare("SELECT 1 FROM settings WHERE key = 'rh_fee_native_v1'").get()) {
      this.db.transaction(() => {
        this.db.prepare(`UPDATE candidates
          SET candidate_json = json_remove(candidate_json, '$.totalFeesUsd')
          WHERE chain = 'robinhood' AND state NOT IN ('reserved', 'settled')`).run();
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('rh_fee_native_v1', 'done')").run();
      })();
    }
  }

  close(): void { this.db.close(); }

  addCandidate(candidate: Candidate): boolean {
    const normalized = candidate.chain === "sol" ? candidate.token : candidate.token.toLowerCase();
    const insert = this.db.prepare(`INSERT OR IGNORE INTO candidates
      (id, chain, token, candidate_json, state, reasons_json, observed_at)
      VALUES (?, ?, ?, ?, 'detected', '[]', ?)`);
    return insert.run(candidateKey(candidate), candidate.chain, normalized, JSON.stringify(candidate), Date.now()).changes === 1;
  }

  hasCandidate(chain: Candidate["chain"], token: string): boolean {
    const normalized = chain === "sol" ? token : token.toLowerCase();
    return Boolean(this.db.prepare("SELECT 1 FROM candidates WHERE chain = ? AND token = ?").get(chain, normalized));
  }

  getTokenMetadata(chain: Candidate["chain"], token: string): TokenMetadata | null {
    const normalized = chain === "sol" ? token : token.toLowerCase();
    const row = this.db.prepare(`SELECT name, symbol, image_url, fetched_at, expires_at
      FROM token_metadata WHERE chain = ? AND token = ?`).get(chain, normalized) as
      { name: string | null; symbol: string | null; image_url: string | null; fetched_at: number; expires_at: number } | undefined;
    return row ? { name: row.name, symbol: row.symbol, imageUrl: row.image_url,
      fetchedAt: row.fetched_at, expiresAt: row.expires_at } : null;
  }

  putTokenMetadata(chain: Candidate["chain"], token: string, metadata: TokenMetadata): void {
    const normalized = chain === "sol" ? token : token.toLowerCase();
    this.db.prepare(`INSERT INTO token_metadata
      (chain, token, name, symbol, image_url, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain, token) DO UPDATE SET name = excluded.name, symbol = excluded.symbol,
      image_url = excluded.image_url, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`)
      .run(chain, normalized, metadata.name, metadata.symbol, metadata.imageUrl, metadata.fetchedAt, metadata.expiresAt);
  }

  enrichCandidate(chain: Candidate["chain"], token: string, metrics: Partial<Candidate>): void {
    const normalized = chain === "sol" ? token : token.toLowerCase();
    const row = this.db.prepare("SELECT id, candidate_json, state FROM candidates WHERE chain = ? AND token = ?")
      .get(chain, normalized) as { id: string; candidate_json: string; state: CandidateState } | undefined;
    if (!row || row.state === "reserved" || row.state === "settled") return;
    const allowed = ["marketCapUsd", "liquidityUsd", "holders", "volumeUsd1h", "top10Rate", "bundlerRate",
      "insiderRate", "isHoneypot", "isMayhemMode", "quoteMint", "quoteToken", "taxBps", "totalFeesNative", "totalFeesUsd", "feeMetricsAt"] as const;
    const update: Partial<Candidate> = {};
    for (const key of allowed) {
      const value = metrics[key];
      if (value !== undefined) Object.assign(update, { [key]: value });
    }
    const candidate = JSON.parse(row.candidate_json) as Candidate;
    this.db.prepare("UPDATE candidates SET candidate_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...candidate, ...update }), row.id);
  }

  resolvePool(chain: Candidate["chain"], token: string, pool: string): void {
    if (!pool) throw new Error("Cannot resolve an empty pool");
    const normalized = chain === "sol" ? token : token.toLowerCase();
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT id, candidate_json FROM candidates WHERE chain = ? AND token = ?")
        .get(chain, normalized) as { id: string; candidate_json: string } | undefined;
      if (!row) return;
      const candidate = JSON.parse(row.candidate_json) as Candidate;
      if (candidate.pool && candidate.pool.toLowerCase() !== pool.toLowerCase()) throw new Error("Conflicting pool for candidate");
      if (!candidate.pool) this.db.prepare("UPDATE candidates SET candidate_json = ?, state = 'detected' WHERE id = ?")
        .run(JSON.stringify({ ...candidate, pool }), row.id);
    })();
  }

  updateCandidate(id: string, state: CandidateState, reasons: string[]): void {
    const result = this.db.prepare("UPDATE candidates SET state = ?, reasons_json = ? WHERE id = ?")
      .run(state, JSON.stringify(reasons), id);
    if (result.changes !== 1) throw new Error(`Candidate ${id} not found`);
  }

  reserveCandidate(id: string): void {
    const result = this.db.prepare("UPDATE candidates SET state = 'reserved', reasons_json = '[]' WHERE id = ? AND state = 'eligible'").run(id);
    if (result.changes !== 1) throw new Error("Candidate is not eligible for reservation");
  }

  getCandidate(id: string): CandidateRow | undefined {
    const row = this.db.prepare("SELECT id, candidate_json, state, reasons_json, observed_at FROM candidates WHERE id = ?")
      .get(id) as { id: string; candidate_json: string; state: CandidateState;
        reasons_json: string; observed_at: number } | undefined;
    return row && { id: row.id, candidate: JSON.parse(row.candidate_json) as Candidate,
      state: row.state, reasons: JSON.parse(row.reasons_json) as string[], observedAt: row.observed_at };
  }

  getActiveJob(): { candidateId: string; stage: string; data: Record<string, unknown> } | undefined {
    const row = this.db.prepare("SELECT candidate_id, stage, data_json FROM execution_jobs WHERE stage NOT IN ('published', 'aborted') ORDER BY updated_at LIMIT 1")
      .get() as { candidate_id: string; stage: string; data_json: string } | undefined;
    return row && { candidateId: row.candidate_id, stage: row.stage, data: JSON.parse(row.data_json) as Record<string, unknown> };
  }

  getJob(candidateId: string): { stage: string; data: Record<string, unknown> } | undefined {
    const row = this.db.prepare("SELECT stage, data_json FROM execution_jobs WHERE candidate_id = ?")
      .get(candidateId) as { stage: string; data_json: string } | undefined;
    return row && { stage: row.stage, data: JSON.parse(row.data_json) as Record<string, unknown> };
  }

  startJob(candidateId: string): void {
    this.db.transaction(() => {
      if (this.getActiveJob()) throw new Error("Another purchase is in progress");
      this.reserveCandidate(candidateId);
      this.db.prepare("INSERT INTO execution_jobs(candidate_id, stage, data_json, updated_at) VALUES (?, 'reserved', '{}', ?)")
        .run(candidateId, Date.now());
    })();
  }

  advanceJob(candidateId: string, expected: string, next: string, data: Record<string, unknown>): void {
    const result = this.db.prepare("UPDATE execution_jobs SET stage = ?, data_json = ?, updated_at = ? WHERE candidate_id = ? AND stage = ?")
      .run(next, JSON.stringify(data), Date.now(), candidateId, expected);
    if (result.changes !== 1) throw new Error(`Job stage conflict: expected ${expected}`);
  }

  abortJob(candidateId: string, reason: string): void {
    this.db.transaction(() => {
      const job = this.getJob(candidateId);
      const plan = job?.data.buyPlan as { pending?: unknown; fundingIndex?: unknown;
        finalSignature?: unknown } | undefined;
      if (!job || (job.stage !== "converted" && job.stage !== "snapshotted") ||
          (job.stage === "snapshotted" && (plan?.pending || plan?.finalSignature ||
            (plan && plan.fundingIndex !== 0))))
        throw new Error("Cannot abort a purchase with a prepared or pending transaction");
      this.advanceJob(candidateId, job.stage, "aborted", { ...job.data, abortReason: reason });
      this.updateCandidate(candidateId, "rejected", [reason]);
    })();
  }

  publishRound(candidateId: string, root: string, tx: string, claimTarget?: string, chainId?: number,
    deliveryMode: "claim" | "push" = "claim"): void {
    if (!root || !tx) throw new Error("Invalid publication receipt");
    this.db.transaction(() => {
      const job = this.getJob(candidateId);
      if (job?.stage !== "recorded") throw new Error("Round is not ready for publication");
      const candidate = this.getCandidate(candidateId)?.candidate;
      if (deliveryMode === "push" && (candidate?.chain !== "sol" || !claimTarget))
        throw new Error("Automatic delivery requires a Solana reward wallet");
      this.db.prepare(`INSERT INTO published_rounds(candidate_id, root, publish_tx, published_at,
        claim_target, chain_id, delivery_mode) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(candidateId, root, tx,
        Date.now(), claimTarget ?? null, chainId ?? null, deliveryMode);
      if (deliveryMode === "push") this.db.prepare(`INSERT INTO solana_payouts
        (candidate_id, sol_wallet, reward_atoms, state)
        SELECT candidate_id, sol_wallet, reward_atoms, 'pending' FROM allocations
        WHERE candidate_id = ? AND reward_atoms <> '0'`).run(candidateId);
      this.advanceJob(candidateId, "recorded", "published", job.data);
    })();
  }

  getPublishedRound(candidateId: string): { root: string; publishTx: string; claimTarget: string | null;
    chainId: number | null; deliveryMode: "claim" | "push" } | undefined {
    return this.db.prepare(`SELECT root, publish_tx AS publishTx, claim_target AS claimTarget,
      chain_id AS chainId, delivery_mode AS deliveryMode FROM published_rounds WHERE candidate_id = ?`)
      .get(candidateId) as { root: string; publishTx: string; claimTarget: string | null;
        chainId: number | null; deliveryMode: "claim" | "push" } | undefined;
  }

  getSolanaPayout(candidateId: string, solWallet: string): { state: "pending" | "batched" | "sent";
    signature: string | null } | undefined {
    return this.db.prepare(`SELECT state, signature FROM solana_payouts
      WHERE candidate_id = ? AND sol_wallet = ?`).get(candidateId, solWallet) as
      { state: "pending" | "batched" | "sent"; signature: string | null } | undefined;
  }

  nextSolanaPayoutBatch(maxRecipients = 4): { id: number; candidateId: string;
    rows: Array<{ solWallet: string; rewardAtoms: bigint }> } | undefined {
    return this.db.transaction(() => {
      let batch = this.db.prepare(`SELECT id, candidate_id AS candidateId FROM solana_payout_batches
        WHERE state = 'pending' ORDER BY id LIMIT 1`).get() as
        { id: number; candidateId: string } | undefined;
      if (!batch) {
        const first = this.db.prepare(`SELECT candidate_id AS candidateId FROM solana_payouts
          WHERE state = 'pending' ORDER BY rowid LIMIT 1`).get() as { candidateId: string } | undefined;
        if (!first) return undefined;
        const result = this.db.prepare(`INSERT INTO solana_payout_batches(candidate_id, state, created_at)
          VALUES (?, 'pending', ?)`).run(first.candidateId, Date.now());
        batch = { id: Number(result.lastInsertRowid), candidateId: first.candidateId };
        const rows = this.db.prepare(`SELECT sol_wallet AS solWallet FROM solana_payouts
          WHERE candidate_id = ? AND state = 'pending' ORDER BY sol_wallet LIMIT ?`)
          .all(batch.candidateId, maxRecipients) as Array<{ solWallet: string }>;
        const assign = this.db.prepare(`UPDATE solana_payouts SET batch_id = ?, state = 'batched'
          WHERE candidate_id = ? AND sol_wallet = ? AND state = 'pending'`);
        for (const row of rows) assign.run(batch.id, batch.candidateId, row.solWallet);
      }
      const rows = this.db.prepare(`SELECT sol_wallet AS solWallet, reward_atoms AS rewardAtoms
        FROM solana_payouts WHERE batch_id = ? ORDER BY sol_wallet`).all(batch.id) as
        Array<{ solWallet: string; rewardAtoms: string }>;
      if (!rows.length) throw new Error("Empty Solana payout batch");
      return { ...batch, rows: rows.map((row) => ({ solWallet: row.solWallet,
        rewardAtoms: BigInt(row.rewardAtoms) })) };
    })();
  }

  markSolanaPayoutBatchSent(id: number, signature: string): void {
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE solana_payout_batches SET state = 'sent', signature = ?, sent_at = ?
        WHERE id = ? AND state = 'pending'`).run(signature, Date.now(), id);
      if (result.changes !== 1) throw new Error("Solana payout batch is not pending");
      this.db.prepare(`UPDATE solana_payouts SET state = 'sent', signature = ?, sent_at = ?
        WHERE batch_id = ? AND state = 'batched'`).run(signature, Date.now(), id);
    })();
  }

  getSolanaClaim(candidateId: string, solWallet: string): { transactionBase64: string; signature: string;
    lastValidBlockHeight: number; state: "prepared" | "claimed" } | undefined {
    return this.db.prepare(`SELECT transaction_base64 AS transactionBase64, signature,
      last_valid_block_height AS lastValidBlockHeight, state FROM solana_claims
      WHERE candidate_id = ? AND sol_wallet = ?`).get(candidateId, solWallet) as
      { transactionBase64: string; signature: string; lastValidBlockHeight: number;
        state: "prepared" | "claimed" } | undefined;
  }

  savePreparedSolanaClaim(input: { candidateId: string; solWallet: string;
    transactionBase64: string; signature: string; lastValidBlockHeight: number },
    replaceSignature?: string): boolean {
    if (replaceSignature) return this.db.prepare(`UPDATE solana_claims SET transaction_base64 = ?,
      signature = ?, last_valid_block_height = ? WHERE candidate_id = ? AND sol_wallet = ?
      AND state = 'prepared' AND signature = ?`).run(input.transactionBase64, input.signature,
      input.lastValidBlockHeight, input.candidateId, input.solWallet, replaceSignature).changes === 1;
    return this.db.prepare(`INSERT OR IGNORE INTO solana_claims
      (candidate_id, sol_wallet, transaction_base64, signature, last_valid_block_height, state)
      VALUES (?, ?, ?, ?, ?, 'prepared')`).run(input.candidateId, input.solWallet,
        input.transactionBase64, input.signature, input.lastValidBlockHeight).changes === 1;
  }

  markSolanaClaimed(candidateId: string, solWallet: string, signature: string): boolean {
    return this.db.prepare(`UPDATE solana_claims SET state = 'claimed', claimed_at = ?
      WHERE candidate_id = ? AND sol_wallet = ? AND signature = ? AND state = 'prepared'`)
      .run(Date.now(), candidateId, solWallet, signature).changes === 1;
  }

  pendingSolanaClaimsForWallet(solWallet: string): Array<{ candidateId: string; signature: string }> {
    return this.db.prepare(`SELECT candidate_id AS candidateId, signature FROM solana_claims
      WHERE sol_wallet = ? AND state = 'prepared'`).all(solWallet) as
      Array<{ candidateId: string; signature: string }>;
  }

  listCandidates(limit = 100): CandidateRow[] {
    const rows = this.db.prepare("SELECT * FROM candidates ORDER BY observed_at DESC LIMIT ?").all(limit) as Array<{
      id: string; candidate_json: string; state: CandidateState; reasons_json: string; observed_at: number;
    }>;
    return rows.map((row) => ({ id: row.id, candidate: JSON.parse(row.candidate_json) as Candidate,
      state: row.state, reasons: JSON.parse(row.reasons_json) as string[], observedAt: row.observed_at }));
  }

  getCursor(source: string): bigint | undefined {
    const row = this.db.prepare("SELECT height FROM cursors WHERE source = ?").get(source) as { height: string } | undefined;
    return row ? BigInt(row.height) : undefined;
  }

  queueSolanaEvent(source: string, signature: string): void {
    this.db.prepare("INSERT OR IGNORE INTO solana_events(signature, source, observed_at) VALUES (?, ?, ?)")
      .run(signature, source, Date.now());
  }

  listSolanaEvents(source: string, limit = 50): Array<{ signature: string; observedAt: number }> {
    return this.db.prepare("SELECT signature, observed_at AS observedAt FROM solana_events WHERE source = ? ORDER BY observed_at LIMIT ?")
      .all(source, limit) as Array<{ signature: string; observedAt: number }>;
  }

  deleteSolanaEvent(signature: string): void {
    this.db.prepare("DELETE FROM solana_events WHERE signature = ?").run(signature);
  }

  /** Move only after every log in a chunk has been durably recorded. */
  setCursor(source: string, height: bigint): void {
    const current = this.getCursor(source);
    if (current !== undefined && height < current) throw new Error("Indexer cursor may not move backwards");
    this.db.prepare("INSERT INTO cursors(source, height) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET height = excluded.height")
      .run(source, height.toString());
  }

  getFilters(): FilterSet {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'filters'").get() as { value: string } | undefined;
    return row ? { ...disabledFilters, ...JSON.parse(row.value) as FilterSet } : structuredClone(disabledFilters);
  }

  setFilters(filters: FilterSet): void {
    this.db.prepare("INSERT INTO settings(key, value) VALUES ('filters', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(filters));
  }

  /** Fixed on first trading activation; restarts must never make pre-launch migrations buyable. */
  getOrSetExecutionStartAt(requestedAt: number, chain?: Chain): number {
    if (!Number.isSafeInteger(requestedAt) || requestedAt <= 0) throw new Error("Invalid execution start time");
    const key = chain ? `execution_started_at_${chain}` : "execution_started_at";
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)")
      .run(key, String(requestedAt));
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    const startedAt = Number(row?.value);
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) throw new Error("Invalid stored execution start time");
    return startedAt;
  }

  /** The first Solana trading activation also marks the start of the public launch feed. */
  getExecutionStartAt(): number | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'execution_started_at'")
      .get() as { value: string } | undefined;
    if (!row) return undefined;
    const startedAt = Number(row.value);
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) throw new Error("Invalid stored execution start time");
    return startedAt;
  }

  /** Records only an already verified purchase; one round per graduation. */
  recordRound(input: RoundInput): void {
    if (!input.purchaseTx || input.receivedAtoms <= 0n || !Number.isSafeInteger(input.snapshotSlot) || input.snapshotSlot <= 0 ||
        !Number.isInteger(input.rewardDecimals) || input.rewardDecimals < 0 || input.rewardDecimals > 18)
      throw new Error("Invalid purchase receipt or snapshot slot");
    const allocations = allocateExactly(input.receivedAtoms, input.holders);
    if (allocations.reduce((sum, row) => sum + row.rewardAtoms, 0n) !== input.receivedAtoms)
      throw new Error("Allocation does not match received tokens");
    this.db.transaction(() => {
      const candidate = this.db.prepare("SELECT state FROM candidates WHERE id = ?").get(input.candidateId) as { state: CandidateState } | undefined;
      if (candidate?.state !== "reserved") throw new Error("Candidate is not reserved for settlement");
      this.db.prepare("INSERT INTO rounds(candidate_id, purchase_tx, received_atoms, reward_decimals, snapshot_slot, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.candidateId, input.purchaseTx, input.receivedAtoms.toString(), input.rewardDecimals, input.snapshotSlot, Date.now());
      const insert = this.db.prepare("INSERT INTO allocations(candidate_id, sol_wallet, reward_atoms) VALUES (?, ?, ?)");
      for (const row of allocations) insert.run(input.candidateId, row.solWallet, row.rewardAtoms.toString());
      this.db.prepare("UPDATE candidates SET state = 'settled' WHERE id = ?").run(input.candidateId);
    })();
  }

  listRounds(limit = 100): RoundRow[] {
    return this.db.prepare("SELECT candidate_id AS candidateId, purchase_tx AS purchaseTx, received_atoms AS receivedAtoms, reward_decimals AS rewardDecimals, snapshot_slot AS snapshotSlot, created_at AS createdAt FROM rounds ORDER BY created_at DESC LIMIT ?")
      .all(limit) as RoundRow[];
  }

  /** Confirmed rounds only. A missing journal amount stays unknown, never inferred from the budget. */
  purchaseTotals(): PurchaseTotals {
    const rows = this.db.prepare(`SELECT c.chain, j.data_json AS job_json FROM rounds r
      JOIN candidates c ON c.id = r.candidate_id
      LEFT JOIN execution_jobs j ON j.candidate_id = r.candidate_id`).iterate() as Iterable<{
        chain: Chain; job_json: string | null }>;
    const chains = {
      sol: { count: 0, atoms: 0n, missing: 0 },
      bsc: { count: 0, atoms: 0n, missing: 0 },
      robinhood: { count: 0, atoms: 0n, missing: 0 },
    };
    let count = 0;
    let solBudgetLamports = 0n;
    let missingBudget = 0;
    for (const row of rows) {
      count++;
      const chain = chains[row.chain];
      chain.count++;
      let job: Record<string, unknown> = {};
      try { job = row.job_json ? JSON.parse(row.job_json) as Record<string, unknown> : {}; } catch { /* unknown amounts */ }
      const spend = nonnegativeAtoms(job.spendAtoms);
      if (spend === null) chain.missing++; else chain.atoms += BigInt(spend);
      const budget = nonnegativeAtoms(job.budgetLamports);
      if (budget === null) missingBudget++; else solBudgetLamports += BigInt(budget);
    }
    return { count, solBudgetLamports: missingBudget ? null : solBudgetLamports.toString(),
      chains: {
        sol: { count: chains.sol.count, spendAtoms: chains.sol.missing ? null : chains.sol.atoms.toString() },
        bsc: { count: chains.bsc.count, spendAtoms: chains.bsc.missing ? null : chains.bsc.atoms.toString() },
        robinhood: { count: chains.robinhood.count, spendAtoms: chains.robinhood.missing ? null : chains.robinhood.atoms.toString() },
      } };
  }

  purchasePage(limit = 10, cursor?: string): { items: PurchaseRow[]; nextCursor: string | null } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("Invalid purchase page size");
    let before: { createdAt: number; candidateId: string } | null = null;
    if (cursor) {
      const decoded = Buffer.from(cursor, "base64url").toString("utf8");
      const delimiter = decoded.indexOf(":");
      const createdAt = Number(decoded.slice(0, delimiter));
      const candidateId = decoded.slice(delimiter + 1);
      if (delimiter < 1 || !Number.isSafeInteger(createdAt) || createdAt < 0 || !candidateId || candidateId.length > 200)
        throw new Error("Invalid purchase cursor");
      before = { createdAt, candidateId };
    }
    const sql = `SELECT r.candidate_id, r.purchase_tx, r.created_at, c.chain, c.token, c.candidate_json,
      m.name, m.symbol, m.image_url, j.data_json AS job_json
      FROM rounds r JOIN candidates c ON c.id = r.candidate_id
      LEFT JOIN token_metadata m ON m.chain = c.chain AND m.token = c.token
      LEFT JOIN execution_jobs j ON j.candidate_id = r.candidate_id
      ${before ? "WHERE r.created_at < ? OR (r.created_at = ? AND r.candidate_id < ?)" : ""}
      ORDER BY r.created_at DESC, r.candidate_id DESC LIMIT ?`;
    const args = before ? [before.createdAt, before.createdAt, before.candidateId, limit + 1] : [limit + 1];
    const rows = this.db.prepare(sql).all(...args) as Array<{ candidate_id: string; purchase_tx: string;
      created_at: number; chain: Chain; token: string; candidate_json: string; name: string | null;
      symbol: string | null; image_url: string | null; job_json: string | null }>;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map((row) => {
      let job: Record<string, unknown> = {};
      try { job = row.job_json ? JSON.parse(row.job_json) as Record<string, unknown> : {}; } catch { /* unknown amounts */ }
      const candidate = JSON.parse(row.candidate_json) as Candidate;
      return { candidateId: row.candidate_id, chain: row.chain, launchpad: candidate.launchpad,
        token: row.token, name: row.name, symbol: row.symbol, imageUrl: row.image_url,
        purchaseTx: row.purchase_tx, spendAtoms: nonnegativeAtoms(job.spendAtoms),
        budgetLamports: nonnegativeAtoms(job.budgetLamports), createdAt: row.created_at };
    }), nextCursor: rows.length > limit && last
      ? Buffer.from(`${last.created_at}:${last.candidate_id}`).toString("base64url") : null };
  }

  getRound(candidateId: string): RoundRow | undefined {
    return this.db.prepare("SELECT candidate_id AS candidateId, purchase_tx AS purchaseTx, received_atoms AS receivedAtoms, reward_decimals AS rewardDecimals, snapshot_slot AS snapshotSlot, created_at AS createdAt FROM rounds WHERE candidate_id = ?")
      .get(candidateId) as RoundRow | undefined;
  }

  allocationsForRound(candidateId: string): Array<{ solWallet: string; rewardAtoms: bigint }> {
    const rows = this.db.prepare("SELECT sol_wallet AS solWallet, reward_atoms AS rewardAtoms FROM allocations WHERE candidate_id = ? ORDER BY sol_wallet")
      .all(candidateId) as Array<{ solWallet: string; rewardAtoms: string }>;
    return rows.map((row) => ({ solWallet: row.solWallet, rewardAtoms: BigInt(row.rewardAtoms) }));
  }

  allocationsForWallet(solWallet: string): Array<{ candidateId: string; rewardAtoms: string }> {
    return this.db.prepare("SELECT candidate_id AS candidateId, reward_atoms AS rewardAtoms FROM allocations WHERE sol_wallet = ? ORDER BY candidate_id")
      .all(solWallet) as Array<{ candidateId: string; rewardAtoms: string }>;
  }

  rewardsForWallet(solWallet: string): Array<{ candidateId: string; chain: string; launchpad: string; token: string;
    rewardAtoms: string; rewardDecimals: number; purchaseTx: string; snapshotSlot: number }> {
    const rows = this.db.prepare(`SELECT a.candidate_id AS candidateId, a.reward_atoms AS rewardAtoms,
      r.reward_decimals AS rewardDecimals, r.purchase_tx AS purchaseTx, r.snapshot_slot AS snapshotSlot,
      c.candidate_json AS candidateJson FROM allocations a JOIN rounds r ON r.candidate_id = a.candidate_id
      JOIN candidates c ON c.id = a.candidate_id WHERE a.sol_wallet = ? AND a.reward_atoms <> '0'
      ORDER BY r.created_at DESC`).all(solWallet) as
      Array<{ candidateId: string; rewardAtoms: string; rewardDecimals: number; purchaseTx: string; snapshotSlot: number; candidateJson: string }>;
    return rows.map((row) => { const candidate = JSON.parse(row.candidateJson) as Candidate; return {
      candidateId: row.candidateId, chain: candidate.chain, launchpad: candidate.launchpad,
      token: candidate.token, rewardAtoms: row.rewardAtoms, rewardDecimals: row.rewardDecimals,
      purchaseTx: row.purchaseTx, snapshotSlot: row.snapshotSlot,
    }; });
  }

  addLinkChallenge(input: { id: string; solWallet: string; evmWallet: string; message: string; expiresAt: number }): void {
    this.db.prepare("INSERT INTO link_challenges(id, sol_wallet, evm_wallet, message, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.id, input.solWallet, input.evmWallet, input.message, input.expiresAt);
  }

  getLinkChallenge(id: string): { solWallet: string; evmWallet: string; message: string; expiresAt: number; used: number } | undefined {
    return this.db.prepare("SELECT sol_wallet AS solWallet, evm_wallet AS evmWallet, message, expires_at AS expiresAt, used FROM link_challenges WHERE id = ?")
      .get(id) as { solWallet: string; evmWallet: string; message: string; expiresAt: number; used: number } | undefined;
  }

  consumeLinkChallenge(id: string): void {
    this.db.transaction(() => {
      const challenge = this.getLinkChallenge(id);
      if (!challenge || challenge.used || challenge.expiresAt <= Date.now()) throw new Error("Link challenge expired or already used");
      const changed = this.db.prepare("UPDATE link_challenges SET used = 1 WHERE id = ? AND used = 0").run(id).changes;
      if (changed !== 1) throw new Error("Link challenge already used");
      this.db.prepare(`INSERT INTO wallet_links(sol_wallet, evm_wallet, linked_at) VALUES (?, ?, ?)
        ON CONFLICT(sol_wallet) DO UPDATE SET evm_wallet = excluded.evm_wallet, linked_at = excluded.linked_at`)
        .run(challenge.solWallet, challenge.evmWallet, Date.now());
    })();
  }

  getWalletLink(solWallet: string): { evmWallet: string; linkedAt: number } | undefined {
    return this.db.prepare("SELECT evm_wallet AS evmWallet, linked_at AS linkedAt FROM wallet_links WHERE sol_wallet = ?")
      .get(solWallet) as { evmWallet: string; linkedAt: number } | undefined;
  }
}
