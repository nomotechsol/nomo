import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";
import { type Candidate } from "../domain.js";
import { Store } from "../store.js";

const require = createRequire(import.meta.url);
const { PUMP_AMM_PROGRAM_ID, PUMP_AMM_SDK, PUMP_PROGRAM_ID } = require("@pump-fun/pump-swap-sdk") as typeof import("@pump-fun/pump-swap-sdk");
const { bondingCurvePda } = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
const RAYDIUM_LAUNCHLAB = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
const PUMP_MIGRATE = new Set(["migrate", "migrate_v2"].map(discriminator));
const PUMP_MIGRATE_ACCOUNTS = new Map([
  [discriminator("migrate"), { mint: 2, pool: 9 }],
  [discriminator("migrate_v2"), { mint: 2, pool: 10 }],
]);
const STONK_MIGRATE = new Set(["migrate_to_cpswap", "migrate_to_amm"].map(discriminator));
const WINDOW_MS = 15 * 60_000;
const STONK_DISCOVERY_WINDOW_MS = 30 * 60_000;

function discriminator(name: string): string {
  return createHash("sha256").update(`global:${name}`).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(row: Record<string, unknown>, field: string): string | undefined {
  return typeof row[field] === "string" ? row[field] : undefined;
}

function numberField(row: Record<string, unknown>, field: string): number | undefined {
  const value = row[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Checks a finalized migration instruction, its program, and both expected accounts. */
export async function findMigrationTx(connection: Connection, mint: PublicKey, pool: PublicKey,
  program: PublicKey, names: Set<string>, aroundMs: number, signatureAddress: PublicKey = pool): Promise<string | undefined> {
  const signatures = await connection.getSignaturesForAddress(signatureAddress, { limit: 50 }, "finalized");
  const near = signatures.filter((row) => row.err === null && row.blockTime &&
    Math.abs(row.blockTime * 1000 - aroundMs) <= WINDOW_MS).slice(0, 20);
  for (const row of near) {
    const transaction = await connection.getParsedTransaction(row.signature,
      { commitment: "finalized", maxSupportedTransactionVersion: 1 });
    if (!transaction || transaction.meta?.err) continue;
    const keys = new Set(transaction.transaction.message.accountKeys.map((key) => key.pubkey.toBase58()));
    if (!keys.has(mint.toBase58()) || !keys.has(pool.toBase58())) continue;
    const instructions = [
      ...transaction.transaction.message.instructions,
      ...(transaction.meta?.innerInstructions ?? []).flatMap((item) => item.instructions),
    ];
    const match = instructions.some((instruction) => {
      if (!instruction.programId.equals(program) || !("data" in instruction)) return false;
      try { return names.has(Buffer.from(bs58.decode(instruction.data)).subarray(0, 8).toString("hex")); }
      catch { return false; }
    });
    if (match) return row.signature;
  }
  return undefined;
}

export class SolanaDiscovery {
  private readonly connection: Connection;
  private logSubscription?: number;
  private backfillOffset = 0;
  private nextGmgnPollAt = 0;
  private nextGmgnStonkPollAt = 0;
  private nextStonkFallbackAt = 0;
  private gmgnRateLimitUntil = 0;

  constructor(private readonly store: Store, rpcUrl: string, private readonly gmgnKey?: string) {
    this.connection = new Connection(rpcUrl, "finalized");
  }

  async start(): Promise<void> {
    if (this.logSubscription !== undefined) return;
    this.logSubscription = await this.connection.onLogs(PUMP_PROGRAM_ID, (event) => {
      if (event.err || !event.logs.some((line) => line.includes("Instruction: Migrate"))) return;
      this.store.queueSolanaEvent("pumpfun", event.signature);
    }, "confirmed");
  }

  async stop(): Promise<void> {
    if (this.logSubscription === undefined) return;
    const subscription = this.logSubscription;
    this.logSubscription = undefined;
    await this.connection.removeOnLogsListener(subscription);
  }

  async poll(): Promise<number> {
    const [gmgnStonkResult, pumpResult, streamResult, modesResult] = await Promise.allSettled([
      this.gmgnKey ? this.gmgnStonkCandidates() : Promise.resolve([]),
      this.gmgnKey ? this.pumpCandidates() : Promise.resolve([]),
      this.processQueuedPumpEvents(),
      this.refreshPumpModes(),
    ]);
    let inserted = streamResult.status === "fulfilled" ? streamResult.value : 0;
    for (const result of [gmgnStonkResult, pumpResult]) {
      if (result.status === "fulfilled") for (const candidate of result.value)
        if (this.store.addCandidate(candidate)) inserted++;
    }
    // StonkFun's own feed is a fallback when GMGN's bounded completed list misses a migration.
    const [stonkResult] = await Promise.allSettled([
      this.stonkCandidates(),
    ]);
    if (stonkResult.status === "fulfilled") for (const candidate of stonkResult.value)
      if (this.store.addCandidate(candidate)) inserted++;
    if (gmgnStonkResult.status === "rejected") throw gmgnStonkResult.reason;
    if (stonkResult.status === "rejected") throw stonkResult.reason;
    if (pumpResult.status === "rejected") throw pumpResult.reason;
    if (streamResult.status === "rejected") throw streamResult.reason;
    if (modesResult.status === "rejected") throw modesResult.reason;
    return inserted;
  }

  /** Backfill verified pool flags and quote mint for candidates saved before those fields existed. */
  private async refreshPumpModes(): Promise<void> {
    const allPending = this.store.listCandidates(10_000).filter((row) => row.candidate.launchpad === "pumpfun" &&
      (row.candidate.isMayhemMode === undefined || row.candidate.quoteMint === undefined) && row.candidate.pool &&
      row.state !== "reserved" && row.state !== "settled");
    if (!allPending.length) { this.backfillOffset = 0; return; }
    const start = this.backfillOffset % allPending.length;
    const pending = [...allPending.slice(start), ...allPending.slice(0, start)].slice(0, 30);
    this.backfillOffset = (start + pending.length) % allPending.length;
    const accounts = await this.connection.getMultipleAccountsInfo(
      pending.map((row) => new PublicKey(row.candidate.pool)), "finalized");
    for (const [index, row] of pending.entries()) {
      const info = accounts[index];
      if (!info?.owner.equals(PUMP_AMM_PROGRAM_ID)) continue;
      try {
        const pool = PUMP_AMM_SDK.decodePool(info);
        if (!pool.baseMint.equals(new PublicKey(row.candidate.token))) continue;
        this.store.enrichCandidate("sol", row.candidate.token, {
          isMayhemMode: pool.isMayhemMode, quoteMint: pool.quoteMint.toBase58(),
        });
      } catch { /* An unverified pool stays in needs_data. */ }
    }
  }

  private async processQueuedPumpEvents(): Promise<number> {
    let inserted = 0;
    for (const event of this.store.listSolanaEvents("pumpfun")) {
      const tx = await this.connection.getParsedTransaction(event.signature,
        { commitment: "finalized", maxSupportedTransactionVersion: 1 });
      if (!tx) {
        if (Date.now() - event.observedAt > 5 * 60_000) this.store.deleteSolanaEvent(event.signature);
        continue;
      }
      if (tx.meta?.err || !tx.blockTime) { this.store.deleteSolanaEvent(event.signature); continue; }
      const instructions = [
        ...tx.transaction.message.instructions,
        ...(tx.meta?.innerInstructions ?? []).flatMap((item) => item.instructions),
      ];
      for (const instruction of instructions) {
        if (!instruction.programId.equals(PUMP_PROGRAM_ID) || !("data" in instruction)) continue;
        const discriminator = Buffer.from(bs58.decode(instruction.data)).subarray(0, 8).toString("hex");
        const indexes = PUMP_MIGRATE_ACCOUNTS.get(discriminator);
        if (!indexes || instruction.accounts.length <= indexes.pool) continue;
        const mint = instruction.accounts[indexes.mint]!;
        const pool = instruction.accounts[indexes.pool]!;
        const poolInfo = await this.connection.getAccountInfo(pool, "finalized");
        if (!poolInfo?.owner.equals(PUMP_AMM_PROGRAM_ID)) continue;
        const decoded = PUMP_AMM_SDK.decodePool(poolInfo);
        if (!decoded.baseMint.equals(mint)) continue;
        if (this.store.hasCandidate("sol", mint.toBase58())) continue;
        if (this.store.addCandidate({ chain: "sol", launchpad: "pumpfun", token: mint.toBase58(),
          pool: pool.toBase58(), graduationTx: event.signature, graduatedAt: tx.blockTime * 1000,
          isMayhemMode: decoded.isMayhemMode, quoteMint: decoded.quoteMint.toBase58() })) inserted++;
      }
      this.store.deleteSolanaEvent(event.signature);
    }
    return inserted;
  }

  private async stonkCandidates(): Promise<Candidate[]> {
    if (Date.now() < this.nextStonkFallbackAt) return [];
    this.nextStonkFallbackAt = Date.now() + 60_000;
    const url = "https://www.stonkfun.xyz/api/public/v1/tokens?sort=newest&status=graduated&pageSize=100";
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`StonkFun API HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const data = isRecord(payload) ? payload.data : undefined;
    const tokens = isRecord(data) && Array.isArray(data.tokens) ? data.tokens : [];
    const candidates: Candidate[] = [];
    const existing = new Map(this.store.listCandidates(10_000)
      .filter((row) => row.candidate.launchpad === "stonkfun")
      .map((row) => [row.candidate.token, row.candidate]));
    for (const value of tokens) {
      if (!isRecord(value)) continue;
      const token = stringField(value, "mint");
      const pool = stringField(value, "pool");
      const quote = isRecord(value.quote) ? stringField(value.quote, "mint") : undefined;
      const at = parseTime(value.graduatedAt);
      if (!token || !pool || !quote || !at) continue;
      const saved = existing.get(token);
      if (saved) {
        if (saved.pool === pool && !saved.quoteMint)
          this.store.enrichCandidate("sol", token, { quoteMint: new PublicKey(quote).toBase58() });
        continue;
      }
      if (Date.now() - at > STONK_DISCOVERY_WINDOW_MS || this.store.hasCandidate("sol", token)) continue;
      const candidate = await this.verifyStonkCandidate(value);
      if (candidate) candidates.push(candidate);
      if (candidates.length >= 10) break;
    }
    return candidates;
  }

  private async gmgnStonkCandidates(): Promise<Candidate[]> {
    if (Date.now() < this.nextGmgnStonkPollAt || Date.now() < this.gmgnRateLimitUntil) return [];
    this.nextGmgnStonkPollAt = Date.now() + 10_000;
    const rows = await this.gmgnCompleted("stonkfun");
    const candidates: Candidate[] = [];
    for (const row of rows) {
      const token = stringField(row, "address");
      const at = parseTime(row.complete_timestamp);
      if (stringField(row, "launchpad_platform")?.toLowerCase() !== "stonkfun" || !token || !at ||
          Date.now() - at > STONK_DISCOVERY_WINDOW_MS || this.store.hasCandidate("sol", token)) continue;
      // GMGN's pool_address is the destination CPMM. StonkFun exposes the LaunchLab
      // origin pool, whose migration instruction can be verified on chain.
      const response = await fetch(`https://www.stonkfun.xyz/api/public/v1/tokens/${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const payload: unknown = await response.json();
      const data = isRecord(payload) ? payload.data : undefined;
      const detail = isRecord(data) ? data.token : undefined;
      if (!isRecord(detail) || stringField(detail, "mint") !== token) continue;
      const candidate = await this.verifyStonkCandidate(detail, at);
      if (candidate) candidates.push(candidate);
      if (candidates.length >= 10) break;
    }
    return candidates;
  }

  private async verifyStonkCandidate(value: Record<string, unknown>, expectedAt?: number): Promise<Candidate | undefined> {
    const token = stringField(value, "mint");
    const pool = stringField(value, "pool");
    const quote = isRecord(value.quote) ? stringField(value.quote, "mint") : undefined;
    const at = parseTime(value.graduatedAt);
    if (!token || !pool || !quote || !at ||
        (expectedAt !== undefined && Math.abs(expectedAt - at) > WINDOW_MS)) return undefined;
    const mintKey = new PublicKey(token);
    const poolKey = new PublicKey(pool);
    const quoteKey = new PublicKey(quote);
    if (quoteKey.equals(mintKey)) return undefined;
    const poolInfo = await this.connection.getAccountInfo(poolKey, "finalized");
    if (!poolInfo?.owner.equals(RAYDIUM_LAUNCHLAB)) return undefined;
    const tx = await findMigrationTx(this.connection, mintKey, poolKey, RAYDIUM_LAUNCHLAB, STONK_MIGRATE, at);
    if (!tx) return undefined;
    const market = isRecord(value.market) ? value.market : {};
    return { chain: "sol", launchpad: "stonkfun", token, pool, quoteMint: quoteKey.toBase58(),
      graduationTx: tx, graduatedAt: at,
      marketCapUsd: numberField(market, "marketCapUsd"), liquidityUsd: numberField(market, "liquidityUsd"),
      volumeUsd1h: numberField(market, "volume1hUsd") };
  }

  private async gmgnCompleted(platform: string): Promise<Record<string, unknown>[]> {
    const query = new URLSearchParams({ chain: "sol", timestamp: String(Math.floor(Date.now() / 1000)), client_id: randomUUID() });
    const response = await fetch(`https://openapi.gmgn.ai/v1/trenches?${query}`, {
      method: "POST", headers: { "content-type": "application/json", "X-APIKEY": this.gmgnKey! },
      body: JSON.stringify({ version: "v2", completed: { filters: ["offchain", "onchain"],
        launchpad_platform_v2: true, limit: 80, launchpad_platform: [platform],
        quote_address_type: [4, 5, 3, 1, 13, 0] } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      this.gmgnRateLimitUntil = Number.isFinite(reset) && reset > Date.now() / 1000
        ? reset * 1000 + 30_000 : Date.now() + 60_000;
    }
    if (!response.ok) throw new Error(`GMGN trenches HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const data = isRecord(payload) ? payload.data : undefined;
    return isRecord(data) && Array.isArray(data.completed) ? data.completed.filter(isRecord) : [];
  }

  private async pumpCandidates(): Promise<Candidate[]> {
    if (Date.now() < this.nextGmgnPollAt || Date.now() < this.gmgnRateLimitUntil) return [];
    this.nextGmgnPollAt = Date.now() + 60_000;
    const rows = await this.gmgnCompleted("Pump.fun");
    const candidates: Candidate[] = [];
    for (const value of rows) {
      if (!isRecord(value)) continue;
      const platform = stringField(value, "launchpad_platform")?.toLowerCase() ?? "";
      if (platform !== "pump.fun") continue;
      const token = stringField(value, "address");
      const pool = stringField(value, "pool_address");
      const at = parseTime(value.complete_timestamp);
      if (!token || !pool || !at || Date.now() - at > WINDOW_MS || this.store.hasCandidate("sol", token)) continue;
      const mintKey = new PublicKey(token);
      const poolKey = new PublicKey(pool);
      const poolInfo = await this.connection.getAccountInfo(poolKey, "finalized");
      if (!poolInfo?.owner.equals(PUMP_AMM_PROGRAM_ID)) continue;
      const decoded = PUMP_AMM_SDK.decodePool(poolInfo);
      if (!decoded.baseMint.equals(mintKey)) continue;
      const tx = await findMigrationTx(this.connection, mintKey, poolKey, PUMP_PROGRAM_ID, PUMP_MIGRATE, at,
        bondingCurvePda(mintKey));
      if (!tx) continue;
      candidates.push({ chain: "sol", launchpad: "pumpfun", token, pool, graduationTx: tx, graduatedAt: at,
        isMayhemMode: decoded.isMayhemMode, quoteMint: decoded.quoteMint.toBase58() });
      if (candidates.length >= 10) break;
    }
    return candidates;
  }
}
