import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { PublicKey, type Connection } from "@solana/web3.js";
import { SolanaDiscovery } from "../src/solana/discovery.js";
import { Store } from "../src/store.js";

const mint = "2TD3VJ6rTNagTZ9oprHPfh5b7er8bXDTs8Atyvdq48XL";
const originPool = "8mJKVkbXVvZ95CiL5rSCSbgyUoEVfuJsCZgHsMtWUh1G";
const migratedPool = "67DAfBBZb7F7dZkyj3X5GELJ2qwjYFs8xhKrctpXEUuy";
const quoteMint = "So11111111111111111111111111111111111111112";
const launchLab = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");

describe("GMGN StonkFun graduation discovery", () => {
  it("uses GMGN as discovery and verifies the different LaunchLab origin with Solana RPC", async () => {
    const now = Date.now();
    const migrationData = bs58.encode(Buffer.from(createHash("sha256")
      .update("global:migrate_to_cpswap").digest().subarray(0, 8)));
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("openapi.gmgn.ai")) return Response.json({ data: { completed: [{
        address: mint, pool_address: migratedPool, launchpad_platform: "stonkfun",
        complete_timestamp: Math.floor(now / 1000),
      }] } });
      return Response.json({ data: { token: { mint, pool: originPool, quote: { mint: quoteMint },
        graduatedAt: new Date(now).toISOString(), market: { liquidityUsd: 16_000 } } } });
    });
    const connection = {
      getAccountInfo: async () => ({ owner: launchLab }),
      getSignaturesForAddress: async () => [{ signature: "migration-tx", err: null,
        blockTime: Math.floor(now / 1000) }],
      getParsedTransaction: async () => ({ meta: { err: null, innerInstructions: [] },
        transaction: { message: { accountKeys: [{ pubkey: new PublicKey(mint) },
          { pubkey: new PublicKey(originPool) }],
          instructions: [{ programId: launchLab, data: migrationData }] } } }),
    } as unknown as Connection;
    const store = new Store(":memory:");
    try {
      const scanner = new SolanaDiscovery(store, "https://example.invalid", "read-key");
      Object.assign(scanner, { connection });
      const candidates = await (scanner as unknown as {
        gmgnStonkCandidates(): Promise<Array<{ token: string; pool: string; quoteMint?: string;
          graduationTx: string }>>;
      }).gmgnStonkCandidates();
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ token: mint, pool: originPool,
        quoteMint, graduationTx: "migration-tx" });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      request.mockRestore();
      store.close();
    }
  });
});
