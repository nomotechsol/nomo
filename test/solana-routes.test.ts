import { describe, expect, it } from "vitest";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { RaydiumFundingQuotes } from "../src/execution/solana-routes.js";

const sol = "So11111111111111111111111111111111111111112";
const pump = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const quote = "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo";
const poolA = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
const poolB = "6PTm7MkUmtsLU7w6dWrMHJAt8PnzoCgcZdKyTKEhUAPL";
const clmm = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

function setup(change: Record<string, unknown> = {}, owner = clmm) {
  const data = { swapType: "BaseIn", inputMint: sol, outputMint: quote, inputAmount: "10000000",
    outputAmount: "5000", otherAmountThreshold: "4950", slippageBps: 100, priceImpactPct: 0.01,
    routePlan: [{ poolId: poolA, inputMint: sol, outputMint: usdc },
      { poolId: poolB, inputMint: usdc, outputMint: quote }], ...change };
  const request = (async () => Response.json({ success: true, data })) as typeof fetch;
  const connection = { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() =>
    ({ owner }) as AccountInfo<Buffer>) } as unknown as Connection;
  return new RaydiumFundingQuotes(connection, request);
}

describe("Raydium funding for non-SOL PumpSwap quote assets", () => {
  it("accepts a verified SOL → USDC → custom quote route", async () => {
    const result = await setup().quote(new PublicKey(quote), 10_000_000n, 100);
    expect(result.pools).toEqual([poolA, poolB]);
    expect(result.minimumQuoteAtoms).toBe(4950n);
    expect(result.quoteMint).toBe(quote);
  });

  it("accepts the selected 99% slippage for a verified Raydium route", async () => {
    const result = await setup({ slippageBps: 9900, otherAmountThreshold: "50" })
      .quote(new PublicKey(quote), 10_000_000n, 9900);
    expect(result.minimumQuoteAtoms).toBe(50n);
    await expect(setup().quote(new PublicKey(quote), 10_000_000n, 9901))
      .rejects.toThrow("slippage");
  });

  it("quotes a verified PUMP → SOL creator-fee conversion", async () => {
    const result = await setup({ inputMint: pump, outputMint: sol, slippageBps: 9900,
      otherAmountThreshold: "50", routePlan: [{ poolId: poolA, inputMint: pump, outputMint: sol }] })
      .quotePair(new PublicKey(pump), new PublicKey(sol), 10_000_000n, 9900);
    expect(result.inputMint).toBe(pump);
    expect(result.quoteMint).toBe(sol);
    expect(result.minimumQuoteAtoms).toBe(50n);
  });

  it("rejects a discontinuous route, foreign pool and excessive price impact", async () => {
    await expect(setup({ routePlan: [{ poolId: poolA, inputMint: sol, outputMint: usdc },
      { poolId: poolB, inputMint: sol, outputMint: quote }] }).quote(new PublicKey(quote), 10_000_000n, 100))
      .rejects.toThrow("discontinuous");
    await expect(setup({}, PublicKey.default).quote(new PublicKey(quote), 10_000_000n, 100))
      .rejects.toThrow("unverified pool");
    await expect(setup({ priceImpactPct: 100 }).quote(new PublicKey(quote), 10_000_000n, 100))
      .rejects.toThrow("price-impact cap");
  });
});
