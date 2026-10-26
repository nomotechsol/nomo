import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { eligibleNomoHolders } from "../src/solana/snapshot.js";

describe("NOMO holder threshold", () => {
  it("includes exactly 1,000,000 whole tokens and excludes smaller balances", () => {
    const below = Keypair.fromSeed(Buffer.alloc(32, 1)).publicKey.toBase58();
    const at = Keypair.fromSeed(Buffer.alloc(32, 2)).publicKey.toBase58();
    const balances = new Map([
      [below, 999_999n * 1_000_000n],
      [at, 1_000_000n * 1_000_000n],
    ]);
    expect(eligibleNomoHolders(balances, 6)).toEqual([
      { solWallet: at, rawBalance: 1_000_000n * 1_000_000n },
    ]);
  });
});
