import { createHash } from "node:crypto";
import { type Allocation, type Candidate, type Chain, type Holder, evaluateCandidate, missingCandidateData,
  quarterOfCurrentBalance, splitBoughtTokens } from "../domain.js";
import { Store } from "../store.js";

export type SnapshotReceipt = { slot: number; holders: Holder[] };
export type BuyReceipt = { tx: string; receivedAtoms: bigint; rewardDecimals: number };
export type FundingReceipt = { tx: string; creditedAtoms: bigint; ownerRetainedAtoms: bigint };
export type PublicationReceipt = { tx: string; root: string; claimTarget?: string; chainId?: number };

/** External operations MUST reconcile by operationId before sending another transaction. */
export interface ExecutionAdapter {
  /** Treasury inflow from NOMO's own creator fees; unrelated to a candidate's GMGN Total Fees. */
  collectCreatorFees(operationId: string): Promise<{ tx: string }>;
  convertPumpToSol(operationId: string): Promise<{ tx: string }>;
  availableSolLamports(): Promise<bigint>;
  bridge(operationId: string, candidate: Candidate, amountLamports: bigint): Promise<{ tx: string; receivedAtoms: bigint }>;
  snapshot(operationId: string): Promise<SnapshotReceipt>;
  buy(operationId: string, candidate: Candidate, spendAtoms: bigint): Promise<BuyReceipt>;
  fund(operationId: string, candidate: Candidate, purchase: BuyReceipt,
    holderAtoms: bigint, ownerAtoms: bigint): Promise<FundingReceipt>;
  publish(operationId: string, candidate: Candidate, roundId: bigint, allocations: Allocation[],
    fundedAtoms: bigint): Promise<PublicationReceipt>;
}

const string = (data: Record<string, unknown>, key: string): string => {
  const value = data[key];
  if (typeof value !== "string") throw new Error(`Missing journal field ${key}`);
  return value;
};
const integer = (data: Record<string, unknown>, key: string): number => {
  const value = data[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid journal field ${key}`);
  return Number(value);
};

export function deterministicRoundId(candidateId: string): bigint {
  return createHash("sha256").update(candidateId).digest().readBigUInt64LE(0);
}

const MIN_PURCHASE_LAMPORTS = 1_000_000_000n;

export class ExecutionEngine {
  private readonly executionStartAt: Record<Chain, number>;
  private readonly maxGraduationAgeMs: number;
  private readonly solFeeReserveLamports: bigint;
  private readonly chains: ReadonlySet<Chain>;

  constructor(private readonly store: Store, private readonly adapter: ExecutionAdapter,
    options: { activatedAt: number; maxGraduationAgeMs?: number; solFeeReserveLamports?: bigint;
      chains?: Chain[] }) {
    this.chains = new Set(options.chains ?? ["sol", "bsc", "robinhood"]);
    this.executionStartAt = { sol: store.getOrSetExecutionStartAt(options.activatedAt),
      bsc: this.chains.has("bsc") ? store.getOrSetExecutionStartAt(options.activatedAt, "bsc")
        : Number.MAX_SAFE_INTEGER,
      robinhood: this.chains.has("robinhood") ? store.getOrSetExecutionStartAt(options.activatedAt, "robinhood")
        : Number.MAX_SAFE_INTEGER };
    this.maxGraduationAgeMs = options.maxGraduationAgeMs ?? 5 * 60_000;
    this.solFeeReserveLamports = options.solFeeReserveLamports ?? 50_000_000n;
    if (!Number.isSafeInteger(this.maxGraduationAgeMs) || this.maxGraduationAgeMs <= 0)
      throw new Error("Invalid graduation freshness limit");
  }

  /** One candidate at a time; every external call is journalled for crash recovery. */
  async tick(now = Date.now()): Promise<string | undefined> {
    let active = this.store.getActiveJob();
    if (!active) {
      const filters = this.store.getFilters();
      const eligible = this.store.listCandidates(10_000).filter((row) => row.state === "eligible" &&
        this.chains.has(row.candidate.chain) &&
        row.candidate.graduatedAt > this.executionStartAt[row.candidate.chain] && row.candidate.graduatedAt <= now &&
        now - row.candidate.graduatedAt <= this.maxGraduationAgeMs)
        .sort((a, b) => a.candidate.graduatedAt - b.candidate.graduatedAt || a.id.localeCompare(b.id));
      const row = eligible.find((entry) => {
        // An aborted purchase is final for this graduation, even if classification later
        // marks the token eligible again when its market data is refreshed.
        if (this.store.getJob(entry.id)) return false;
        const rule = filters[entry.candidate.launchpad];
        // Screen the OTHER token's post-graduation trading fees before any treasury action.
        return missingCandidateData(entry.candidate, rule).length === 0 &&
          evaluateCandidate(entry.candidate, rule, now).length === 0;
      });
      if (!row) return undefined;
      this.store.startJob(row.id);
      active = this.store.getActiveJob();
    }
    if (!active) throw new Error("Purchase journal was not created");
    const candidate = this.store.getCandidate(active.candidateId)?.candidate;
    if (!candidate) throw new Error("Journal candidate is missing");
    if (!this.chains.has(candidate.chain)) throw new Error(`Pending ${candidate.chain} job requires its execution adapter`);
    if (candidate.graduatedAt <= this.executionStartAt[candidate.chain])
      throw new Error("Purchase journal predates trading activation");
    const id = active.candidateId;
    let { stage, data } = active;
    const advance = (next: string, patch: Record<string, unknown>) => {
      this.store.advanceJob(id, stage, next, { ...data, ...patch });
      stage = next;
      data = { ...data, ...patch };
    };
    if (stage === "reserved") {
      const receipt = await this.adapter.collectCreatorFees(`${id}:collect`);
      advance("collected", { collectTx: receipt.tx });
    }
    if (stage === "collected") {
      const receipt = await this.adapter.convertPumpToSol(`${id}:convert`);
      advance("converted", { conversionTx: receipt.tx });
    }
    if (stage === "converted") {
      const balance = await this.adapter.availableSolLamports();
      const budget = quarterOfCurrentBalance(balance, this.solFeeReserveLamports);
      if (budget < MIN_PURCHASE_LAMPORTS) {
        this.store.abortJob(id, "purchase_budget_below_1_sol");
        return undefined;
      }
      advance("budgeted", { budgetLamports: budget.toString() });
    }
    if (stage === "budgeted") {
      const budget = BigInt(string(data, "budgetLamports"));
      // A journal written by an older version may already contain a smaller budget.
      // Stop before any new bridge or buy; the operator must reconcile that journal.
      if (budget < MIN_PURCHASE_LAMPORTS)
        throw new Error("Pending purchase budget is below the 1 SOL minimum");
      const receipt = candidate.chain === "sol" ? { tx: "same-chain", receivedAtoms: budget }
        : await this.adapter.bridge(`${id}:bridge`, candidate, budget);
      if (receipt.receivedAtoms <= 0n) throw new Error("Bridge produced no spendable assets");
      advance("bridged", { bridgeTx: receipt.tx, spendAtoms: receipt.receivedAtoms.toString() });
    }
    if (stage === "bridged") {
      const receipt = await this.adapter.snapshot(`${id}:snapshot`);
      if (!Number.isSafeInteger(receipt.slot) || receipt.slot <= 0 || receipt.holders.length === 0)
        throw new Error("Invalid holder snapshot");
      advance("snapshotted", { snapshotSlot: receipt.slot,
        holders: receipt.holders.map((holder) => ({ solWallet: holder.solWallet, rawBalance: holder.rawBalance.toString() })) });
    }
    if (stage === "snapshotted") {
      const buyPlan = data.buyPlan as { pending?: unknown; fundingIndex?: unknown;
        finalSignature?: unknown } | undefined;
      if (!buyPlan?.pending && !buyPlan?.finalSignature && (!buyPlan || buyPlan.fundingIndex === 0)) {
        const rule = this.store.getFilters()[candidate.launchpad];
        const fresh = candidate.graduatedAt > this.executionStartAt[candidate.chain] &&
          now - candidate.graduatedAt <= this.maxGraduationAgeMs &&
          missingCandidateData(candidate, rule).length === 0 &&
          evaluateCandidate(candidate, rule, now).length === 0;
        if (!fresh) {
          this.store.abortJob(id, "expired_or_filtered_before_buy");
          return undefined;
        }
      }
      const receipt = await this.adapter.buy(`${id}:buy`, candidate, BigInt(string(data, "spendAtoms")));
      if (!receipt.tx || receipt.receivedAtoms <= 0n || !Number.isInteger(receipt.rewardDecimals) ||
          receipt.rewardDecimals < 0 || receipt.rewardDecimals > 18) throw new Error("Invalid buy receipt");
      advance("purchased", { purchaseTx: receipt.tx, purchasedAtoms: receipt.receivedAtoms.toString(),
        rewardDecimals: receipt.rewardDecimals });
    }
    if (stage === "purchased") {
      const purchase = {
        tx: string(data, "purchaseTx"), receivedAtoms: BigInt(string(data, "purchasedAtoms")),
        rewardDecimals: integer(data, "rewardDecimals"),
      };
      const split = splitBoughtTokens(purchase.receivedAtoms);
      const receipt = await this.adapter.fund(`${id}:fund`, candidate, purchase, split.holderAtoms, split.ownerAtoms);
      if (!receipt.tx || receipt.creditedAtoms <= 0n || receipt.creditedAtoms > split.holderAtoms ||
          receipt.ownerRetainedAtoms !== split.ownerAtoms)
        throw new Error("Invalid vault funding receipt");
      advance("funded", { fundingTx: receipt.tx, fundedAtoms: receipt.creditedAtoms.toString(),
        ownerRetainedAtoms: receipt.ownerRetainedAtoms.toString() });
    }
    if (stage === "funded") {
      if (!this.store.getRound(id)) {
        const rows = data.holders;
        if (!Array.isArray(rows)) throw new Error("Snapshot missing from journal");
        const holders = rows.map((row) => {
          if (typeof row !== "object" || row === null || !("solWallet" in row) || !("rawBalance" in row) ||
              typeof row.solWallet !== "string" || typeof row.rawBalance !== "string")
            throw new Error("Corrupt holder snapshot");
          return { solWallet: row.solWallet, rawBalance: BigInt(row.rawBalance) };
        });
        this.store.recordRound({ candidateId: id, purchaseTx: string(data, "purchaseTx"),
          receivedAtoms: BigInt(string(data, "fundedAtoms")), rewardDecimals: integer(data, "rewardDecimals"),
          snapshotSlot: integer(data, "snapshotSlot"), holders });
      }
      advance("recorded", {});
    }
    if (stage === "recorded") {
      const receipt = await this.adapter.publish(`${id}:publish`, candidate, deterministicRoundId(id),
        this.store.allocationsForRound(id), BigInt(string(data, "fundedAtoms")));
      this.store.publishRound(id, receipt.root, receipt.tx, receipt.claimTarget, receipt.chainId,
        candidate.chain === "sol" ? "push" : "claim");
    }
    return id;
  }
}
