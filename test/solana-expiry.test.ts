import { describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import { expiredSignatureAbsent } from "../src/execution/solana-expiry.js";

describe("finalized Solana expiry reconciliation", () => {
  it("requires status history at least as recent as the finalized expiry tip", async () => {
    const connection = {
      getEpochInfo: async () => ({ blockHeight: 151, absoluteSlot: 300 }),
      getSignatureStatuses: async () => ({ context: { slot: 299 }, value: [null] }),
    } as unknown as Connection;
    await expect(expiredSignatureAbsent(connection, "sig", 150)).rejects.toThrow("behind");
  });

  it("does not replace a transaction still within its blockhash lifetime", async () => {
    const connection = { getEpochInfo: async () => ({ blockHeight: 150, absoluteSlot: 300 }),
      getSignatureStatuses: async () => { throw new Error("unnecessary history read"); } } as unknown as Connection;
    expect(await expiredSignatureAbsent(connection, "sig", 150)).toBe(false);
  });

  it("does not replace a transaction found in chain history", async () => {
    const connection = {
      getEpochInfo: async () => ({ blockHeight: 151, absoluteSlot: 300 }),
      getSignatureStatuses: async () => ({ context: { slot: 301 },
        value: [{ err: null, confirmationStatus: "finalized" }] }),
    } as unknown as Connection;
    expect(await expiredSignatureAbsent(connection, "sig", 150)).toBe(false);
  });
});
