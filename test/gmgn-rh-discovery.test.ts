import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, type PublicClient } from "viem";
import { EvmGraduationScanner } from "../src/evm/scanner.js";
import { GmgnRhDiscovery } from "../src/gmgn/rh-discovery.js";
import { Store } from "../src/store.js";

describe("GMGN Robinhood graduation hints", () => {
  it("finds a fresh Pons token only after its on-chain graduation and pool are verified", async () => {
    const store = new Store(":memory:");
    const token = "0x1111111111111111111111111111111111111111" as const;
    const quote = "0x3333333333333333333333333333333333333333" as const;
    const hook = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as const;
    const [a, b] = token.toLowerCase() < quote.toLowerCase() ? [token, quote] : [quote, token];
    const pool = keccak256(encodeAbiParameters([
      { type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" },
      { type: "address" },
    ], [a, b, 0, 200, hook]));
    const transactionHash = `0x${"aa".repeat(32)}` as const;
    let logQueries = 0;
    const client = {
      getChainId: async () => 4663,
      getBlockNumber: async () => 1004n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber }),
      getLogs: async ({ event, args, fromBlock, toBlock }: {
        event: { name: string }; args?: { token?: string[] }; fromBlock: bigint; toBlock: bigint;
      }) => {
        logQueries++;
        return event.name === "PoolGraduated" && args?.token?.includes(token) &&
          fromBlock <= 1000n && toBlock >= 1000n
          ? [{ args: { token }, transactionHash, blockNumber: 1000n }] : [];
      },
      readContract: async () => ({ exists: true, phase: 2, token, pairToken: quote,
        poolFee: 0, tickSpacing: 200 }),
    } as unknown as PublicClient;
    const scanner = new EvmGraduationScanner(store, { source: "pons_v2", rpcUrl: "http://unused" }, client);
    let requests = 0;
    const request = (async () => {
      requests++;
      return Response.json({ code: 0, data: { completed: [
        { address: token, launchpad_platform: "pons_v2", complete_timestamp: 1000 },
        { address: "0x2222222222222222222222222222222222222222",
          launchpad_platform: "pons_v2", complete_timestamp: 1 },
        { address: "0x4444444444444444444444444444444444444444",
          launchpad_platform: "other", complete_timestamp: 1000 },
      ] } });
    }) as typeof fetch;
    const discovery = new GmgnRhDiscovery(store, "test-key", "http://unused", scanner, request, client);
    expect(await discovery.poll(1_001_000)).toBe(1);
    expect(store.listCandidates()).toHaveLength(1);
    expect(store.listCandidates()[0]?.candidate).toMatchObject({ chain: "robinhood", launchpad: "pons_v2",
      token, pool, quoteToken: quote, graduationTx: transactionHash });
    expect(store.listCandidates()[0]?.candidate.totalFeesNative).toBeUndefined();
    expect(store.getCursor("pons_v2")).toBeUndefined();
    expect(logQueries).toBe(1);
    expect(await discovery.poll(1_002_000)).toBe(0);
    expect(requests).toBe(1);
    store.close();
  });
});
