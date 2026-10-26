import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters,
  keccak256, parseAbi, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { PonsV4Swap } from "../src/execution/pons-v4-swap.js";

const native = "0x0000000000000000000000000000000000000000";
const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const quote = "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68";
const token = "0x40d1bd9CDcbfb9e4116603a50948f7b579A1e5A9";
const hook = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const pool = keccak256(encodeAbiParameters([
  { type: "address" }, { type: "address" }, { type: "uint24" },
  { type: "int24" }, { type: "address" },
], [token, quote, 0, 200, hook]));
const candidate = { chain: "robinhood" as const, launchpad: "pons_v2" as const,
  token, pool, quoteToken: quote, graduationTx: "0xgraduated", graduatedAt: Date.now() };
const routerAbi = parseAbi(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);

describe("Pons V2 on-chain custom-pair route", () => {
  it("encodes a quoted ETH → USDG → pair asset → Pons v4 purchase", async () => {
    let simulatedPath: Array<{ intermediateCurrency: string }> = [];
    const client = {
      readContract: async () => ({ exists: true, phase: 2, token, pairToken: quote,
        poolFee: 0, tickSpacing: 200 }),
      getLogs: async ({ args }: { args: { currency0: string; currency1: string } }) =>
        args.currency0.toLowerCase() === usdg.toLowerCase() &&
        args.currency1.toLowerCase() === quote.toLowerCase()
          ? [{ args: { fee: 3000, tickSpacing: 60, hooks: native } }] : [],
      simulateContract: async ({ args }: { args: Array<{ path: Array<{ intermediateCurrency: string }> }> }) => {
        simulatedPath = args[0]!.path;
        return { result: [10_000n, 100_000n] };
      },
    } as unknown as PublicClient;
    const result = await new PonsV4Swap("http://unused", client)
      .quote(candidate, 100n, "0x03508bb71268bba25ecacc8f620e01866650532c");
    expect(simulatedPath.map((hop) => hop.intermediateCurrency.toLowerCase()))
      .toEqual([usdg.toLowerCase(), quote.toLowerCase(), token.toLowerCase()]);
    expect(result).toMatchObject({ amountIn: 100n, expectedOut: 10_000n,
      minimumOut: 100n, value: 100n });
    const decoded = decodeFunctionData({ abi: routerAbi, data: result.data });
    expect(decoded.functionName).toBe("execute");
    expect(decoded.args[0]).toBe("0x10");
    const [actions] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], decoded.args[1][0]!);
    expect(actions).toBe("0x070c0f");
  });

  it("refuses a candidate whose pool ID differs from the Pons factory", async () => {
    const client = { readContract: async () => ({ exists: true, phase: 2, token, pairToken: quote,
      poolFee: 0, tickSpacing: 200 }) } as unknown as PublicClient;
    await expect(new PonsV4Swap("http://unused", client)
      .quote({ ...candidate, pool: `0x${"11".repeat(32)}` }, 100n,
        "0x03508bb71268bba25ecacc8f620e01866650532c"))
      .rejects.toThrow("pool differs");
  });
});
