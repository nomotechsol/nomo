import { describe, expect, it } from "vitest";
import { GmgnFeeEnricher } from "../src/gmgn/fees.js";
import { Store } from "../src/store.js";
import { disabledFilters, evaluateCandidate } from "../src/domain.js";

describe("GMGN per-token fee enrichment", () => {
  it("automatically requests a verified BNB graduation by its discovered address", async () => {
    const store = new Store(":memory:");
    store.addCandidate({ chain: "bsc", launchpad: "flap_tax", token: "0xAb", pool: "0xPool",
      quoteToken: "0xOtherQuote", graduationTx: "0xTx", graduatedAt: 100_000 });
    store.setFilters({ ...disabledFilters, flap_tax: { enabled: true, minTotalFeesNative: 0.15 } });
    const urls: URL[] = [];
    const request = (async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      return Response.json({ data: { address: "0xab", launchpad_platform: "flap",
        total_fee: "0.4", holder_count: 101 } });
    }) as typeof fetch;
    const enricher = new GmgnFeeEnricher(store, "test-key", request);
    await enricher.poll(100_500);
    const candidate = store.listCandidates()[0]!.candidate;
    expect(candidate.totalFeesNative).toBe(0.4);
    expect(candidate.holders).toBe(101);
    expect(candidate.feeMetricsAt).toBe(100_500);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.pathname).toBe("/v1/token/info");
    expect(urls[0]!.searchParams.get("address")).toBe("0xAb");
    await enricher.poll(101_000);
    expect(urls).toHaveLength(1);
    store.close();
  });

  it("compares GMGN RH fees directly in ETH without requesting prices", async () => {
    const store = new Store(":memory:");
    store.addCandidate({ chain: "robinhood", launchpad: "pons_v2", token: "0xAb", pool: "0xPool",
      quoteToken: "0x0000000000000000000000000000000000000000", graduationTx: "0xTx", graduatedAt: 100_000 });
    store.setFilters({ ...disabledFilters, pons_v2: { enabled: true, minTotalFeesNative: 0.042934 } });
    let calls = 0;
    const request = (async () => {
      calls++;
      return Response.json({ data: { address: "0xab", launchpad_platform: "pons", total_fee: 0.043,
        pool: { pool_address: "0xPool", quote_address: "0x0000000000000000000000000000000000000000",
          quote_reserve: "10", quote_reserve_value: "50000" } } });
    }) as typeof fetch;
    await new GmgnFeeEnricher(store, "test-key", request).poll(100_500);
    const candidate = store.listCandidates()[0]!.candidate;
    expect(candidate.totalFeesNative).toBe(0.043);
    expect(evaluateCandidate(candidate, store.getFilters().pons_v2, 100_500)).toEqual([]);
    expect(evaluateCandidate({ ...candidate, totalFeesNative: 0.0429 },
      store.getFilters().pons_v2, 100_500)).toContain("total_fees_native_below_min");
    expect(calls).toBe(1);
    store.close();
  });

  it("uses GMGN native ETH fees for a custom Pons pair without reserve conversion", async () => {
    const store = new Store(":memory:");
    store.addCandidate({ chain: "robinhood", launchpad: "pons_v2", token: "0xAb", pool: "0xPool",
      quoteToken: "0xStock", graduationTx: "0xTx", graduatedAt: 100_000 });
    store.setFilters({ ...disabledFilters, pons_v2: { enabled: true, minTotalFeesNative: 0.042934 } });
    const request = (async (input: string | URL | Request) => {
      if (String(input).includes("coingecko")) throw new Error("ETH price must not be used for custom pair");
      return Response.json({ data: { address: "0xab", launchpad_platform: "pons_v2",
        total_fee: "0.2", pool: { pool_address: "0xPool", quote_address: "0xStock",
          quote_reserve: "2", quote_reserve_value: "1000" } } });
    }) as typeof fetch;
    await new GmgnFeeEnricher(store, "test-key", request).poll(100_500);
    const candidate = store.listCandidates()[0]!.candidate;
    expect(candidate.totalFeesNative).toBe(0.2);
    expect(candidate.totalFeesUsd).toBeUndefined();
    expect(evaluateCandidate(candidate, store.getFilters().pons_v2, 100_500)).toEqual([]);
    store.close();
  });

  it("ignores GMGN Pons fees when its quoted pool disagrees with the on-chain pool", async () => {
    const store = new Store(":memory:");
    store.addCandidate({ chain: "robinhood", launchpad: "pons_v2", token: "0xAb", pool: "0xVerified",
      quoteToken: "0xStock", graduationTx: "0xTx", graduatedAt: 100_000 });
    store.setFilters({ ...disabledFilters, pons_v2: { enabled: true, minTotalFeesNative: 0.042934 } });
    const request = (async () => Response.json({ data: { address: "0xab",
      launchpad_platform: "pons_v2", total_fee: "5", pool: {
        pool_address: "0xDifferent", quote_address: "0xStock",
        quote_reserve: "2", quote_reserve_value: "1000",
      } } })) as typeof fetch;
    await new GmgnFeeEnricher(store, "test-key", request).poll(100_500);
    expect(store.listCandidates()[0]!.candidate.totalFeesNative).toBeUndefined();
    store.close();
  });

  it("does not query Mayhem candidates", async () => {
    const store = new Store(":memory:");
    store.addCandidate({ chain: "sol", launchpad: "pumpfun", token: "mayhem", pool: "pool",
      graduationTx: "sig", graduatedAt: 100_000, isMayhemMode: true, quoteMint: "quote" });
    store.setFilters({ ...disabledFilters, pumpfun: { enabled: true, minTotalFeesNative: 1 } });
    let calls = 0;
    const request = (async () => { calls++; return Response.json({}); }) as typeof fetch;
    await new GmgnFeeEnricher(store, "test-key", request).poll(100_500);
    expect(calls).toBe(0);
    store.close();
  });

  it("checks a non-SOL Pump.fun pair by mint and validates its migrated pool", async () => {
    const store = new Store(":memory:");
    store.addCandidate({ chain: "sol", launchpad: "pumpfun", token: "missed-mint", pool: "verified-pool",
      graduationTx: "sig", graduatedAt: 100_000, isMayhemMode: false, quoteMint: "other-quote" });
    store.setFilters({ ...disabledFilters, pumpfun: { enabled: true, minTotalFeesNative: 1 } });
    const request = (async () => Response.json({ data: { address: "missed-mint",
      launchpad_platform: "Pump.fun", migrated_pool: "verified-pool", total_fee: "25.35" } })) as typeof fetch;
    await new GmgnFeeEnricher(store, "test-key", request).poll(100_500);
    expect(store.listCandidates()[0]!.candidate.totalFeesNative).toBe(25.35);
    store.close();
  });

  it("rejects token info with a different verified pool", async () => {
    const store = new Store(":memory:");
    store.addCandidate({ chain: "sol", launchpad: "pumpfun", token: "mint", pool: "verified-pool",
      graduationTx: "sig", graduatedAt: 100_000, isMayhemMode: false, quoteMint: "other-quote" });
    store.setFilters({ ...disabledFilters, pumpfun: { enabled: true, minTotalFeesNative: 1 } });
    const request = (async () => Response.json({ data: { address: "mint",
      launchpad_platform: "Pump.fun", migrated_pool: "different-pool", total_fee: "25.35" } })) as typeof fetch;
    await new GmgnFeeEnricher(store, "test-key", request).poll(100_500);
    expect(store.listCandidates()[0]!.candidate.totalFeesNative).toBeUndefined();
    store.close();
  });

  it("accepts StonkFun fees when GMGN identifies the migrated CPMM instead of the LaunchLab pool", async () => {
    const store = new Store(":memory:");
    store.addCandidate({ chain: "sol", launchpad: "stonkfun", token: "stonk-mint",
      pool: "launchlab-origin", quoteMint: "sol", graduationTx: "verified-migration",
      graduatedAt: 100_000 });
    store.setFilters({ ...disabledFilters, stonkfun: { enabled: true, minTotalFeesNative: 1 } });
    const request = (async () => Response.json({ data: { address: "stonk-mint",
      launchpad_platform: "stonkfun", migrated_pool: "raydium-cpmm", total_fee: "4.41" } })) as typeof fetch;
    await new GmgnFeeEnricher(store, "test-key", request).poll(100_500);
    expect(store.listCandidates()[0]!.candidate.totalFeesNative).toBe(4.41);
    store.close();
  });
});
