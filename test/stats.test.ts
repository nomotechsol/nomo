import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { buildStatsSummary, fetchSpotQuotes } from "../src/stats.js";
import { candidateKey } from "../src/domain.js";

describe("purchase statistics", () => {
  it("counts only confirmed rounds and paginates them ten at a time without duplicates", () => {
    const store = new Store(":memory:");
    try {
      for (let index = 0; index < 25; index++) {
        const chain = index === 23 ? "bsc" as const : index === 24 ? "robinhood" as const : "sol" as const;
        const launchpad = chain === "sol" ? "pumpfun" as const : chain === "bsc" ? "fourmeme" as const : "pons_v2" as const;
        const token = chain === "sol" ? `Mint${index}` : `0x${String(index).padStart(40, "0")}`;
        const candidate = { chain, launchpad, token, pool: `Pool${index}`, graduationTx: `Tx${index}`, graduatedAt: 1 };
        store.addCandidate(candidate);
        const candidateId = candidateKey(candidate);
        store.updateCandidate(candidateId, "eligible", []);
        store.reserveCandidate(candidateId);
        const spendAtoms = chain === "sol" ? "1000000000" : chain === "bsc" ? "500000000000000000" : "2000000000000000000";
        store.db.prepare(`INSERT INTO execution_jobs(candidate_id, stage, data_json, updated_at)
          VALUES (?, 'published', ?, ?)`).run(candidateId,
          JSON.stringify({ spendAtoms, budgetLamports: "1000000000" }), Date.now());
        store.recordRound({ candidateId, purchaseTx: `Buy${index}`, receivedAtoms: 10n,
          rewardDecimals: 6, snapshotSlot: 1, holders: [{ solWallet: "Holder", rawBalance: 500_000n }] });
      }
      const first = store.purchasePage();
      const second = store.purchasePage(10, first.nextCursor!);
      const third = store.purchasePage(10, second.nextCursor!);
      expect([first.items.length, second.items.length, third.items.length]).toEqual([10, 10, 5]);
      expect(third.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items, ...third.items].map((item) => item.candidateId)).size).toBe(25);
      const totals = store.purchaseTotals();
      expect(totals.count).toBe(25);
      expect(totals.solBudgetLamports).toBe("25000000000");
      expect(totals.chains.sol).toEqual({ count: 23, spendAtoms: "23000000000" });
      expect(totals.chains.bsc).toEqual({ count: 1, spendAtoms: "500000000000000000" });
      expect(totals.chains.robinhood).toEqual({ count: 1, spendAtoms: "2000000000000000000" });
      const summary = buildStatsSummary(totals, {
        sol: { usd: 100, source: "binance", fetchedAt: 1 },
        bsc: { usd: 600, source: "binance", fetchedAt: 1 },
        robinhood: { usd: 2_000, source: "coingecko", fetchedAt: 1 },
      });
      expect(summary.totalUsd).toBe(6_600);
    } finally { store.close(); }
  });

  it("uses a public USD fallback when Binance is unavailable", async () => {
    const fakeFetch = (async (url: string | URL | Request) => new URL(String(url)).hostname === "data-api.binance.vision"
      ? new Response(null, { status: 503 })
      : Response.json({ solana: { usd: 100 }, binancecoin: { usd: 600 }, ethereum: { usd: 2_000 } })) as typeof fetch;
    const quotes = await fetchSpotQuotes(fakeFetch);
    expect(quotes.sol?.source).toBe("coingecko");
    expect(quotes.bsc?.usd).toBe(600);
    expect(quotes.robinhood?.usd).toBe(2_000);
  });
});
