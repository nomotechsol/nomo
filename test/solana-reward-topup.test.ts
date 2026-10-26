import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair, SystemInstruction, TransactionMessage,
  VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { Store } from "../src/store.js";
import { SolanaRewardTopUp } from "../src/execution/solana-reward-topup.js";

const config = { thresholdLamports: 100_000_000, amountLamports: 300_000_000,
  treasuryReserveLamports: 4_000_000_000 };

function fixture() {
  const store = new Store(":memory:");
  const treasury = Keypair.generate();
  const reward = Keypair.generate();
  let treasuryBalance = 10_000_000_000;
  let rewardBalance = 50_000_000;
  const sent: VersionedTransaction[] = [];
  const sendRawTransaction = vi.fn(async (bytes: Uint8Array) => {
    const transaction = VersionedTransaction.deserialize(bytes);
    sent.push(transaction);
    treasuryBalance -= config.amountLamports + 5000;
    rewardBalance += config.amountLamports;
    return bs58.encode(transaction.signatures[0]!);
  });
  const rpc = {
    getBalance: vi.fn(async (wallet: { equals(other: unknown): boolean }) =>
      wallet.equals(treasury.publicKey) ? treasuryBalance : rewardBalance),
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 500 }),
    getFeeForMessage: async () => ({ value: 5000 }),
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 100,
    simulateTransaction: async () => ({ value: { err: null } }),
    sendRawTransaction,
    confirmTransaction: async () => ({ value: { err: null } }),
  } as unknown as Connection;
  const treasurySigner = { publicKey: treasury.publicKey, async sign(tx: VersionedTransaction) {
    tx.sign([treasury]); return tx;
  } };
  const rewardSigner = { publicKey: reward.publicKey, async sign(tx: VersionedTransaction) {
    tx.sign([reward]); return tx;
  } };
  const topUp = new SolanaRewardTopUp(store, rpc, treasurySigner, rewardSigner, config);
  return { store, treasury, reward, sent, sendRawTransaction, topUp,
    setRewardBalance: (value: number) => { rewardBalance = value; },
    setTreasuryBalance: (value: number) => { treasuryBalance = value; } };
}

describe("Solana reward wallet auto top-up", () => {
  it("transfers the bounded amount once when low and records confirmation", async () => {
    const f = fixture();
    try {
      expect(await f.topUp.tick()).toBeTruthy();
      expect(await f.topUp.tick()).toBeUndefined();
      expect(f.sendRawTransaction).toHaveBeenCalledOnce();
      const instruction = TransactionMessage.decompile(f.sent[0]!.message).instructions[0]!;
      const transfer = SystemInstruction.decodeTransfer(instruction);
      expect(transfer.fromPubkey.equals(f.treasury.publicKey)).toBe(true);
      expect(transfer.toPubkey.equals(f.reward.publicKey)).toBe(true);
      expect(transfer.lamports).toBe(300_000_000n);
      expect(f.store.db.prepare("SELECT state FROM solana_reward_topups").get())
        .toEqual({ state: "confirmed" });
    } finally { f.store.close(); }
  });

  it("resumes a signed pending transfer without creating another operation", async () => {
    const f = fixture();
    try {
      f.sendRawTransaction.mockRejectedValueOnce(new Error("temporary RPC failure"));
      await expect(f.topUp.tick()).rejects.toThrow("temporary RPC failure");
      expect(f.store.db.prepare("SELECT state FROM solana_reward_topups").get())
        .toEqual({ state: "pending" });
      const firstSignature = (f.store.db.prepare(`SELECT signature FROM solana_signed_operations
        WHERE operation_id = 'reward-topup:1'`).get() as { signature: string }).signature;
      expect(await f.topUp.tick()).toBe(firstSignature);
      expect(f.sendRawTransaction).toHaveBeenCalledTimes(2);
      expect(f.store.db.prepare("SELECT count(*) AS n FROM solana_reward_topups").get())
        .toEqual({ n: 1 });
    } finally { f.store.close(); }
  });

  it("allows subsequent funding after cooldown and keeps a treasury reserve", async () => {
    const f = fixture();
    try {
      await f.topUp.tick();
      f.setRewardBalance(50_000_000);
      expect(await f.topUp.tick()).toBeUndefined();
      f.store.db.prepare(`UPDATE solana_reward_topups SET confirmed_at = ?`)
        .run(Date.now() - 61_000);
      expect(await f.topUp.tick()).toBeTruthy();
      expect(f.sendRawTransaction).toHaveBeenCalledTimes(2);
      f.store.close();
      const g = fixture();
      try {
        g.setTreasuryBalance(4_300_000_000);
        await expect(g.topUp.tick()).rejects.toThrow("treasury reserve");
        expect(g.sendRawTransaction).not.toHaveBeenCalled();
      } finally { g.store.close(); }
    } catch (error) { throw error; }
  });
});
