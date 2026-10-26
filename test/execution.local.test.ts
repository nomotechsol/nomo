import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { disabledFilters, type Candidate, type FilterSet } from "../src/domain.js";
import { ExecutionEngine, type ExecutionAdapter } from "../src/execution/engine.js";
import { Store } from "../src/store.js";

const wallet = (byte: number) => Keypair.fromSeed(Buffer.alloc(32, byte)).publicKey.toBase58();

class LocalAdapter implements ExecutionAdapter {
  balance = 100_000_000_000n;
  spends: bigint[] = [];
  ownerRetained: bigint[] = [];
  operations = new Map<string, unknown>();
  failPublication = false;

  async collectCreatorFees(id: string) { return this.once(id, () => ({ tx: `claim:${id}` })); }
  async convertPumpToSol(id: string) { return this.once(id, () => ({ tx: `convert:${id}` })); }
  async availableSolLamports() { return this.balance; }
  async bridge(id: string, _candidate: Candidate, amount: bigint) { return this.once(id, () => {
    this.balance -= amount;
    this.spends.push(amount);
    return { tx: `bridge:${id}`, receivedAtoms: amount * 2n };
  }); }
  async snapshot(id: string) { return this.once(id, () => ({ slot: 123,
    holders: [{ solWallet: wallet(1), rawBalance: 1_000_000n }, { solWallet: wallet(2), rawBalance: 3_000_000n }] })); }
  async buy(id: string, candidate: Candidate, amount: bigint) { return this.once(id, () => {
    if (candidate.chain === "sol") { this.balance -= amount; this.spends.push(amount); }
    return { tx: `buy:${id}`, receivedAtoms: 1000n, rewardDecimals: 0 };
  }); }
  async fund(id: string, _candidate: Candidate, _purchase: { receivedAtoms: bigint }, holderAtoms: bigint,
    ownerAtoms: bigint) { return this.once(id, () => {
    this.ownerRetained.push(ownerAtoms);
    return { tx: `fund:${id}`, creditedAtoms: holderAtoms, ownerRetainedAtoms: ownerAtoms };
  }); }
  async publish(id: string, candidate: Candidate, roundId: bigint,
    allocations: Array<{ solWallet: string; rewardAtoms: bigint }>, funded: bigint) {
    if (this.failPublication) { this.failPublication = false; throw new Error("temporary publication failure"); }
    return this.once(id, () => ({ tx: `publish:${id}`, root: `backend:${roundId}`,
      claimTarget: candidate.chain === "sol" ? wallet(9) : undefined }));
  }
  private once<T>(id: string, action: () => T): T {
    if (!this.operations.has(id)) this.operations.set(id, action());
    return this.operations.get(id) as T;
  }
}

describe("local purchase cycle", () => {
  it("never buys the project's own Solana mint", async () => {
    const store = new Store(":memory:");
    store.setFilters({ ...disabledFilters, pumpfun: { enabled: true, minTotalFeesNative: 1 } });
    const now = Date.now();
    store.addCandidate({ chain: "sol", launchpad: "pumpfun", token: "project-mint", pool: "project-pool",
      graduationTx: "project-graduation", graduatedAt: now - 1000, totalFeesNative: 2,
      isMayhemMode: false, quoteMint: "quote" });
    const adapter = new LocalAdapter();
    const engine = new ExecutionEngine(store, adapter,
      { activatedAt: now - 2000, excludedSolanaMint: "project-mint" });
    const row = store.listCandidates()[0]!;
    store.updateCandidate(row.id, "eligible", []);
    expect(await engine.tick(now)).toBeUndefined();
    expect(adapter.spends).toEqual([]);
    expect(store.getJob(row.id)).toBeUndefined();
    store.close();
  });
  it("rejects low-fee bonded tokens, buys sequentially with 25% current balance and resumes publication", async () => {
    const store = new Store(":memory:");
    const filters: FilterSet = { ...disabledFilters, flap_tax: { enabled: true, minTotalFeesNative: 0.15 },
      pumpfun: { enabled: true, minTotalFeesNative: 1 } };
    store.setFilters(filters);
    const now = Date.now();
    const candidates: Candidate[] = [
      { chain: "bsc", launchpad: "flap_tax", token: "0xlow", pool: "0xpool", quoteToken: "0xquote", graduationTx: "0xone",
        graduatedAt: now, totalFeesNative: 0.1 },
      { chain: "bsc", launchpad: "flap_tax", token: "0xgood", pool: "0xpool", quoteToken: "0xquote", graduationTx: "0xtwo",
        graduatedAt: now - 2000, totalFeesNative: 0.4 },
      { chain: "sol", launchpad: "pumpfun", token: "mint", pool: "pool", graduationTx: "sig",
        graduatedAt: now - 1000, totalFeesNative: 1.2, isMayhemMode: false, quoteMint: "quote" },
    ];
    for (const candidate of candidates) store.addCandidate(candidate);
    const ids = store.listCandidates().map((row) => row.id);
    for (const id of ids) store.updateCandidate(id, id.includes("low") ? "rejected" : "eligible", []);
    const adapter = new LocalAdapter();
    const engine = new ExecutionEngine(store, adapter, { activatedAt: now - 3000 });
    adapter.failPublication = true;
    await expect(engine.tick(now)).rejects.toThrow("temporary publication failure");
    expect(store.getActiveJob()?.stage).toBe("recorded");
    expect(store.listRounds()).toHaveLength(1);
    await engine.tick(now);
    expect(store.getActiveJob()).toBeUndefined();
    await engine.tick(now);
    expect(store.listRounds()).toHaveLength(2);
    expect(adapter.spends).toEqual([25_000_000_000n, 18_750_000_000n]);
    expect(adapter.ownerRetained).toEqual([300n, 300n]);
    expect(store.listCandidates().find((row) => row.candidate.token === "0xlow")?.state).toBe("rejected");
    for (const round of store.listRounds()) {
      expect(round.receivedAtoms).toBe("700");
      expect(store.allocationsForRound(round.candidateId)).toEqual([
        { solWallet: wallet(1), rewardAtoms: 175n }, { solWallet: wallet(2), rewardAtoms: 525n },
      ].sort((a, b) => a.solWallet.localeCompare(b.solWallet)));
      if (store.getCandidate(round.candidateId)?.candidate.chain === "sol") {
        expect(store.getPublishedRound(round.candidateId)?.deliveryMode).toBe("push");
        expect(store.getSolanaPayout(round.candidateId, wallet(1))?.state).toBe("pending");
      }
    }
    expect(adapter.operations.size).toBe(13);
    store.close();
  });

  it("skips a sub-1 SOL budget without bridging and buys the next graduation at exactly 1 SOL", async () => {
    const store = new Store(":memory:");
    store.setFilters({ ...disabledFilters,
      flap_tax: { enabled: true, minTotalFeesNative: 0.15 },
      pumpfun: { enabled: true, minTotalFeesNative: 1 } });
    const now = Date.now();
    const candidates: Candidate[] = [
      { chain: "bsc", launchpad: "flap_tax", token: "0xsmall", pool: "0xpool",
        quoteToken: "0xquote", graduationTx: "0xsmall-tx", graduatedAt: now - 2_000,
        totalFeesNative: 0.2 },
      { chain: "sol", launchpad: "pumpfun", token: "exact", pool: "pool",
        quoteMint: "quote", graduationTx: "sig", graduatedAt: now - 1_000,
        totalFeesNative: 1.2, isMayhemMode: false },
    ];
    for (const candidate of candidates) {
      store.addCandidate(candidate);
      const row = store.listCandidates().find((entry) => entry.candidate.token === candidate.token)!;
      store.updateCandidate(row.id, "eligible", []);
    }
    const smallId = store.listCandidates().find((row) => row.candidate.token === "0xsmall")!.id;
    const adapter = new LocalAdapter();
    adapter.balance = 3_999_999_999n; // 25% rounds down to 0.999999999 SOL.
    const engine = new ExecutionEngine(store, adapter, { activatedAt: now - 3_000 });
    expect(await engine.tick(now)).toBeUndefined();
    expect(store.getJob(smallId)?.stage).toBe("aborted");
    expect(store.getJob(smallId)?.data.abortReason).toBe("purchase_budget_below_1_sol");
    expect(store.getActiveJob()).toBeUndefined();
    expect(adapter.spends).toEqual([]);
    expect(store.listRounds()).toHaveLength(0);

    // The scanner may classify it as eligible again; its aborted journal still prevents a retry.
    store.updateCandidate(smallId, "eligible", []);
    adapter.balance = 4_000_000_000n;
    await engine.tick(now);
    expect(store.getJob(smallId)?.stage).toBe("aborted");
    expect(store.listRounds()).toHaveLength(1);
    expect(adapter.spends).toEqual([1_000_000_000n]);
    store.close();
  });

  it("never buys migrations from before activation or stale ones after a restart", async () => {
    const store = new Store(":memory:");
    store.setFilters({ ...disabledFilters, pumpfun: { enabled: true, minTotalFeesNative: 1 } });
    const now = Date.now();
    const activatedAt = now - 20 * 60_000;
    for (const [token, graduatedAt] of [
      ["prelaunch", activatedAt - 1000], ["stale", now - 10 * 60_000], ["fresh", now - 1000],
    ] as const) {
      store.addCandidate({ chain: "sol", launchpad: "pumpfun", token, pool: "pool", graduationTx: token,
        graduatedAt, totalFeesNative: 2, isMayhemMode: false, quoteMint: "quote" });
      const row = store.listCandidates().find((candidate) => candidate.candidate.token === token)!;
      store.updateCandidate(row.id, "eligible", []);
    }
    const adapter = new LocalAdapter();
    const engine = new ExecutionEngine(store, adapter, { activatedAt });
    await engine.tick(now);
    expect(store.listRounds()).toHaveLength(1);
    expect(store.listCandidates().find((row) => row.state === "settled")?.candidate.token).toBe("fresh");
    const restarted = new ExecutionEngine(store, adapter, { activatedAt: now });
    expect(await restarted.tick(now)).toBeUndefined();
    expect(store.getOrSetExecutionStartAt(now)).toBe(activatedAt);
    store.close();
  });

  it("abandons a reserved candidate that becomes stale before any buy is prepared", async () => {
    const store = new Store(":memory:");
    store.setFilters({ ...disabledFilters, pumpfun: { enabled: true, minTotalFeesNative: 1 } });
    const now = Date.now();
    const candidate: Candidate = { chain: "sol", launchpad: "pumpfun", token: "late", pool: "pool",
      graduationTx: "late-sig", graduatedAt: now - 6 * 60_000, totalFeesNative: 2,
      isMayhemMode: false, quoteMint: "quote" };
    store.addCandidate(candidate);
    const id = store.listCandidates()[0]!.id;
    store.updateCandidate(id, "eligible", []);
    store.startJob(id);
    store.advanceJob(id, "reserved", "snapshotted", { spendAtoms: "100", snapshotSlot: 123 });
    const adapter = new LocalAdapter();
    const engine = new ExecutionEngine(store, adapter, { activatedAt: now - 10 * 60_000,
      chains: ["sol"] });
    expect(await engine.tick(now)).toBeUndefined();
    expect(store.getJob(id)?.stage).toBe("aborted");
    expect(store.getActiveJob()).toBeUndefined();
    expect(store.getCandidate(id)?.state).toBe("rejected");
    expect(adapter.spends).toHaveLength(0);
    store.close();
  });

  it("waits for fresh GMGN fees on a reserved job, then completes the buy", async () => {
    const store = new Store(":memory:");
    store.setFilters({ ...disabledFilters, pumpfun: { enabled: true, minTotalFeesNative: 1,
      maxFeeMetricsAgeSeconds: 120 } });
    const now = Date.now();
    store.addCandidate({ chain: "sol", launchpad: "pumpfun", token: "refreshed", pool: "pool",
      graduationTx: "sig", graduatedAt: now - 1_000, totalFeesNative: 2,
      feeMetricsAt: now - 121_000, isMayhemMode: false, quoteMint: "quote" });
    const id = store.listCandidates()[0]!.id;
    store.updateCandidate(id, "eligible", []);
    store.startJob(id);
    store.advanceJob(id, "reserved", "snapshotted", { spendAtoms: "1000000000",
      snapshotSlot: 123, holders: [{ solWallet: wallet(1), rawBalance: "1000000" }] });
    const adapter = new LocalAdapter();
    const engine = new ExecutionEngine(store, adapter, { activatedAt: now - 2_000 });
    expect(await engine.tick(now)).toBeUndefined();
    expect(store.getJob(id)?.stage).toBe("snapshotted");
    expect(adapter.spends).toHaveLength(0);
    store.enrichCandidate("sol", "refreshed", { feeMetricsAt: now });
    await engine.tick(now + 1);
    expect(store.getJob(id)?.stage).toBe("published");
    expect(adapter.spends).toEqual([1_000_000_000n]);
    store.close();
  });

  it("processes only a fresh fee-qualified Pons V2 migration on RH", async () => {
    const store = new Store(":memory:");
    store.setFilters({ ...disabledFilters,
      pons_v2: { enabled: true, minTotalFeesNative: 0.042934, maxFeeMetricsAgeSeconds: 120 } });
    const now = Date.now();
    for (const [token, fees, graduatedAt] of [
      ["old", 0.1, now - 5_000], ["low", 0.04, now - 1_000], ["qualified", 0.05, now - 500],
    ] as const) {
      const candidate: Candidate = { chain: "robinhood", launchpad: "pons_v2", token,
        pool: `pool:${token}`, quoteToken: "0x0000000000000000000000000000000000000000",
        graduationTx: `tx:${token}`, graduatedAt, totalFeesNative: fees, feeMetricsAt: now };
      store.addCandidate(candidate);
      const row = store.listCandidates().find((item) => item.candidate.token === token)!;
      store.updateCandidate(row.id, fees < 0.042934 ? "rejected" : "eligible", []);
    }
    const adapter = new LocalAdapter();
    const engine = new ExecutionEngine(store, adapter,
      { activatedAt: now - 2_000, chains: ["sol", "robinhood"] });
    await engine.tick(now);
    expect(store.listRounds()).toHaveLength(1);
    const row = store.getCandidate(store.listRounds()[0]!.candidateId)!;
    expect(row.candidate.token).toBe("qualified");
    expect(adapter.spends).toEqual([25_000_000_000n]);
    expect(adapter.ownerRetained).toEqual([300n]);
    expect(store.listRounds()[0]!.receivedAtoms).toBe("700");
    store.close();
  });
});
