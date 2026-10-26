import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, type PublicClient } from "viem";
import { EvmGraduationScanner } from "../src/evm/scanner.js";
import { Store } from "../src/store.js";

describe("Pons V2 event ordering", () => {
  const hook = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
  const poolFor = (token: `0x${string}`, quote: `0x${string}`) => {
    const [a, b] = token.toLowerCase() < quote.toLowerCase() ? [token, quote] : [quote, token];
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" },
      { type: "uint24" }, { type: "int24" }, { type: "address" }], [a, b, 0, 200, hook]));
  };
  it("links a registration from a later transaction in the same scan window", async () => {
    const store = new Store(":memory:");
    const token = "0x1111111111111111111111111111111111111111" as const;
    const quoteToken = "0x3333333333333333333333333333333333333333" as const;
    const poolId = poolFor(token, quoteToken);
    const client = {
      getBlockNumber: async () => 104n,
      getBlock: async () => ({ timestamp: 1000n }),
      getLogs: async ({ event }: { event: { name: string } }) => event.name === "PoolGraduated"
        ? [{ args: { token }, transactionHash: `0x${"aa".repeat(32)}`, blockNumber: 100n }]
        : [{ args: { memecoin: token, poolId, quoteToken }, transactionHash: `0x${"bb".repeat(32)}`, blockNumber: 101n }],
      readContract: async () => ({ exists: true, phase: 2, token, pairToken: quoteToken,
        poolFee: 0, tickSpacing: 200 }),
    } as unknown as PublicClient;
    const scanner = new EvmGraduationScanner(store, { source: "pons_v2", rpcUrl: "http://unused",
      startBlock: 100n, confirmations: 1n }, client);
    expect(await scanner.poll()).toBe(1);
    expect(store.listCandidates()[0]?.candidate.pool).toBe(poolId);
    expect(store.listCandidates()[0]?.candidate.quoteToken).toBe(quoteToken);
    expect(store.getCursor("pons_v2")).toBe(103n);
    store.close();
  });

  it("derives a native ETH pool from the factory even before the hook registration appears", async () => {
    const store = new Store(":memory:");
    const token = "0x1111111111111111111111111111111111111111" as const;
    const quoteToken = "0x0000000000000000000000000000000000000000" as const;
    const poolId = poolFor(token, quoteToken);
    const client = {
      getBlockNumber: async () => 106n,
      getBlock: async () => ({ timestamp: 1000n }),
      getLogs: async ({ event, fromBlock }: { event: { name: string }; fromBlock: bigint }) =>
        event.name === "PoolGraduated" && fromBlock === 100n
          ? [{ args: { token }, transactionHash: `0x${"aa".repeat(32)}`, blockNumber: 100n }]
          : event.name === "PoolRegistered" && fromBlock === 104n
            ? [{ args: { memecoin: token, poolId, quoteToken },
              transactionHash: `0x${"bb".repeat(32)}`, blockNumber: 104n }]
            : [],
      readContract: async () => ({ exists: true, phase: 2, token, pairToken: quoteToken,
        poolFee: 0, tickSpacing: 200 }),
    } as unknown as PublicClient;
    const scanner = new EvmGraduationScanner(store, { source: "pons_v2", rpcUrl: "http://unused",
      startBlock: 100n, confirmations: 1n, chunkSize: 4n }, client);
    expect(await scanner.poll()).toBe(1);
    expect(store.listCandidates()[0]?.candidate.quoteToken).toBe(quoteToken);
    expect(store.listCandidates()[0]?.candidate.pool).toBe(poolId);
    expect(await scanner.poll()).toBe(0);
    expect(store.listCandidates()[0]?.candidate.pool).toBe(poolId);
    expect(store.listCandidates()[0]?.candidate.quoteToken).toBe(quoteToken);
    store.close();
  });
});

describe("EVM graduation quote assets", () => {
  it("stores the Flap quote from the on-chain portal instead of assuming WBNB", async () => {
    const store = new Store(":memory:");
    const token = "0x1111111111111111111111111111111111111111";
    const pool = "0x2222222222222222222222222222222222222222";
    const quoteToken = "0x3333333333333333333333333333333333333333";
    const client = {
      getBlockNumber: async () => 104n,
      getBlock: async () => ({ timestamp: 1000n }),
      getLogs: async () => [{ args: { token, pool }, transactionHash: `0x${"aa".repeat(32)}`, blockNumber: 100n }],
      readContract: async () => ({ pool, quoteTokenAddress: quoteToken, buyTaxRate: 150n }),
    } as unknown as PublicClient;
    const scanner = new EvmGraduationScanner(store, { source: "flap", rpcUrl: "http://unused",
      startBlock: 100n, confirmations: 1n }, client);
    expect(await scanner.poll()).toBe(1);
    expect(store.listCandidates()[0]?.candidate).toMatchObject({ launchpad: "flap_tax", quoteToken, taxBps: 150 });
    store.close();
  });

  it("matches Four.meme event quote to the token manager and migrated pair", async () => {
    const store = new Store(":memory:");
    const token = "0x1111111111111111111111111111111111111111";
    const quoteToken = "0x2222222222222222222222222222222222222222";
    const pool = "0x3333333333333333333333333333333333333333";
    const manager = "0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC";
    const info = Array(12).fill(0);
    info[1] = manager;
    info[2] = quoteToken;
    info[11] = true;
    const client = {
      getBlockNumber: async () => 104n,
      getBlock: async () => ({ timestamp: 1000n }),
      getLogs: async () => [{ address: manager, args: { base: token, quote: quoteToken },
        transactionHash: `0x${"aa".repeat(32)}`, blockNumber: 100n }],
      getTransactionReceipt: async () => ({ logs: [{ address: pool }] }),
      readContract: async ({ functionName }: { functionName: string }) => functionName === "getTokenInfo"
        ? info : functionName === "token0" ? token : quoteToken,
    } as unknown as PublicClient;
    const scanner = new EvmGraduationScanner(store, { source: "fourmeme", rpcUrl: "http://unused",
      startBlock: 100n, confirmations: 1n }, client);
    expect(await scanner.poll()).toBe(1);
    expect(store.listCandidates()[0]?.candidate).toMatchObject({ pool, quoteToken });
    store.close();
  });
});
