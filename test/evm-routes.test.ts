import { describe, expect, it } from "vitest";
import { ZeroExEvmPurchaseRoutes } from "../src/execution/evm-routes.js";
import type { Candidate } from "../src/domain.js";

const target = "0x1111111111111111111111111111111111111111";
const customQuote = "0x2222222222222222222222222222222222222222";
const taker = "0x3333333333333333333333333333333333333333";
const candidate: Candidate = { chain: "bsc", launchpad: "flap_tax", token: target,
  pool: "0x4444444444444444444444444444444444444444", quoteToken: customQuote,
  graduationTx: `0x${"aa".repeat(32)}`, graduatedAt: Date.now() };

describe("non-native EVM pair routing", () => {
  it("asks for the target token, and preserves the pool's custom quote asset", async () => {
    let requested: URL | undefined;
    const request = (async (input: string | URL | Request) => {
      requested = new URL(String(input));
      return Response.json({ liquidityAvailable: true, sellToken: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        buyToken: target, sellAmount: "100000000000000000", buyAmount: "2000", minBuyAmount: "1900",
        route: { fills: [{ from: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", to: customQuote,
          source: "PancakeSwap_V3" }, { from: customQuote, to: target, source: "Flap" }] } });
    }) as typeof fetch;
    const route = await new ZeroExEvmPurchaseRoutes("test-key", request)
      .price(candidate, 100000000000000000n, taker);
    expect(requested?.searchParams.get("buyToken")).toBe(target);
    expect(requested?.searchParams.get("chainId")).toBe("56");
    expect(requested?.searchParams.get("slippageBps")).toBe("9900");
    expect(route.poolQuoteToken.toLowerCase()).toBe(customQuote);
    expect(route.minimumTargetAtoms).toBe(1900n);
  });

  it("caps explicit purchase slippage at 99%", async () => {
    await expect(new ZeroExEvmPurchaseRoutes("test-key").price(candidate,
      100000000000000000n, taker, 9901)).rejects.toThrow("EVM purchase requires");
  });

  it("rejects a response for a different token", async () => {
    const request = (async () => Response.json({ liquidityAvailable: true,
      sellToken: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      buyToken: customQuote, sellAmount: "100", buyAmount: "2000", minBuyAmount: "1900",
      route: { fills: [{ from: customQuote, to: target, source: "Flap" }] } })) as typeof fetch;
    await expect(new ZeroExEvmPurchaseRoutes("test-key", request).price(candidate, 100n, taker))
      .rejects.toThrow("differs");
  });
});
