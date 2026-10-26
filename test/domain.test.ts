import { describe, expect, it } from "vitest";
import { allocateExactly, candidateKey, evaluateCandidate, missingCandidateData, quarterOfCurrentBalance,
  splitBoughtTokens } from "../src/domain.js";

describe("buy and allocation rules", () => {
  it("spends 25% of the current balance sequentially", () => {
    const first = quarterOfCurrentBalance(100n, 0n);
    const second = quarterOfCurrentBalance(100n - first, 0n);
    expect([first, second]).toEqual([25n, 18n]);
    expect(quarterOfCurrentBalance(100n, 80n)).toBe(0n);
  });

  it("allocates every received atom with deterministic dust assignment", () => {
    const holders = [
      { solWallet: "B", rawBalance: 500_000n },
      { solWallet: "A", rawBalance: 500_000n },
      { solWallet: "C", rawBalance: 1_000_000n },
    ];
    const rows = allocateExactly(7n, holders);
    expect(rows).toEqual([
      { solWallet: "A", rewardAtoms: 2n },
      { solWallet: "B", rewardAtoms: 2n },
      { solWallet: "C", rewardAtoms: 3n },
    ]);
    expect(rows.reduce((sum, row) => sum + row.rewardAtoms, 0n)).toBe(7n);
  });

  it("keeps 30% of bought tokens with the owner and reserves 70% for holders", () => {
    expect(splitBoughtTokens(1000n)).toEqual({ holderAtoms: 700n, ownerAtoms: 300n });
    expect(splitBoughtTokens(101n)).toEqual({ holderAtoms: 70n, ownerAtoms: 31n });
    expect(() => splitBoughtTokens(1n)).toThrow("too small");
  });

  it("fails closed when a requested metric is missing", () => {
    const candidate = { chain: "sol" as const, launchpad: "pumpfun" as const, token: "mint", pool: "pool", graduationTx: "sig", graduatedAt: 1000, isMayhemMode: false, quoteMint: "quote" };
    expect(evaluateCandidate(candidate, { enabled: true, minLiquidityUsd: 1000 }, 2000)).toEqual(["liquidity_below_min"]);
    expect(missingCandidateData(candidate, { enabled: true, minLiquidityUsd: 1000 })).toEqual(["liquidityUsd"]);
    expect(candidateKey(candidate)).toBe("sol:pumpfun:mint:sig");
    expect(candidateKey({ ...candidate, token: "Ab", graduationTx: "Sig" }))
      .toBe("sol:pumpfun:Ab:Sig");
  });

  it("rejects Pump.fun Mayhem Mode regardless of Total Fees", () => {
    const now = Date.now();
    const candidate = { chain: "sol" as const, launchpad: "pumpfun" as const, token: "mint", pool: "pool",
      graduationTx: "sig", graduatedAt: now, totalFeesNative: 10, feeMetricsAt: now, quoteMint: "quote" };
    const rule = { enabled: true, minTotalFeesNative: 1, maxFeeMetricsAgeSeconds: 120 };
    expect(missingCandidateData(candidate, rule)).toContain("isMayhemMode");
    expect(evaluateCandidate({ ...candidate, isMayhemMode: true }, rule, now)).toContain("mayhem_mode");
    expect(missingCandidateData({ ...candidate, isMayhemMode: false }, rule)).toEqual([]);
    expect(evaluateCandidate({ ...candidate, isMayhemMode: false }, rule, now)).toEqual([]);
  });

  it("filters freshly graduated tokens by GMGN Total Fees", () => {
    const now = 100_000;
    const candidate = { chain: "bsc" as const, launchpad: "flap_tax" as const, token: "0x1", pool: "0x2",
      graduationTx: "0x3", graduatedAt: now - 1000, totalFeesNative: 0.4, feeMetricsAt: now - 5000 };
    const rule = { enabled: true, minTotalFeesNative: 0.15, maxFeeMetricsAgeSeconds: 120 };
    expect(evaluateCandidate(candidate, rule, now)).toEqual([]);
    expect(evaluateCandidate({ ...candidate, totalFeesNative: 0.1 }, rule, now)).toContain("total_fees_native_below_min");
    expect(evaluateCandidate({ ...candidate, feeMetricsAt: now - 121_000 }, rule, now)).toContain("fee_metrics_stale");
    expect(missingCandidateData({ ...candidate, totalFeesNative: undefined }, rule)).toContain("totalFeesNative");
    expect(missingCandidateData(candidate, rule)).toContain("quoteToken");
    expect(missingCandidateData({ ...candidate, quoteToken: "0xquote" }, rule)).not.toContain("quoteToken");
    const rh = { ...candidate, chain: "robinhood" as const, launchpad: "pons_v2" as const,
      totalFeesNative: 0.05 };
    expect(evaluateCandidate(rh, { enabled: true, minTotalFeesNative: 0.042934 }, now)).toEqual([]);
  });
});
