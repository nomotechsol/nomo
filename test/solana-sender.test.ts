import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { Store } from "../src/store.js";
import { SolanaOperationSender } from "../src/execution/solana-sender.js";
import bs58 from "bs58";

describe("durable Solana operation sender", () => {
  it("simulates before sending and reuses the confirmed signature on replay", async () => {
    const wallet = Keypair.generate();
    const store = new Store(":memory:");
    const sendRawTransaction = vi.fn(async (bytes: Uint8Array) =>
      bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!));
    const simulateTransaction = vi.fn(async () => ({ value: { err: null } }));
    const connection = { getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 200 }), getSignatureStatuses: async () => ({ value: [null] }),
      getBlockHeight: async () => 100, simulateTransaction, sendRawTransaction,
      confirmTransaction: async () => ({ value: { err: null } }) } as unknown as Connection;
    const signer = { publicKey: wallet.publicKey, async sign(transaction: VersionedTransaction) {
      transaction.sign([wallet]); return transaction;
    } };
    const sender = new SolanaOperationSender(store, connection, signer);
    const build = vi.fn(async () => new VersionedTransaction(new TransactionMessage({
      payerKey: wallet.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey,
        toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    }).compileToV0Message()));
    const first = await sender.execute("operation-1", build);
    expect(first).toBeTruthy();
    expect(simulateTransaction).toHaveBeenCalledOnce();
    expect(sendRawTransaction).toHaveBeenCalledOnce();
    expect(await sender.execute("operation-1", build)).toBe(first);
    expect(build).toHaveBeenCalledOnce();
    expect(sendRawTransaction).toHaveBeenCalledOnce();
    store.close();
  });

  it("rejects a signer that changes the transaction message", async () => {
    const wallet = Keypair.generate();
    const store = new Store(":memory:");
    const connection = { getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 200 }) } as unknown as Connection;
    const signer = { publicKey: wallet.publicKey, async sign(transaction: VersionedTransaction) {
      transaction.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
      transaction.sign([wallet]); return transaction;
    } };
    const sender = new SolanaOperationSender(store, connection, signer);
    const build = async () => new VersionedTransaction(new TransactionMessage({
      payerKey: wallet.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey,
        toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    }).compileToV0Message());
    await expect(sender.execute("operation-2", build)).rejects.toThrow("changed");
    store.close();
  });

  it("rebuilds an expired operation only after a finalized tip and newer absent-signature read", async () => {
    const wallet = Keypair.generate();
    const store = new Store(":memory:");
    const oldSignature = Keypair.generate().publicKey.toBase58();
    const newBlockhash = Keypair.generate().publicKey.toBase58();
    const calls: string[] = [];
    const connection = {
      getSignatureStatuses: async () => { calls.push("status"); return { context: { slot: 201 }, value: [null] }; },
      getBlockHeight: async () => 201,
      getEpochInfo: async () => { calls.push("finalized"); return { absoluteSlot: 200, blockHeight: 150 }; },
      getLatestBlockhash: async () => ({ blockhash: newBlockhash, lastValidBlockHeight: 300 }),
      simulateTransaction: async () => ({ value: { err: null } }),
      sendRawTransaction: async (bytes: Uint8Array) =>
        bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!),
      confirmTransaction: async () => ({ value: { err: null } }),
    } as unknown as Connection;
    const signer = { publicKey: wallet.publicKey, async sign(tx: VersionedTransaction) {
      tx.sign([wallet]); return tx;
    } };
    const sender = new SolanaOperationSender(store, connection, signer);
    store.db.prepare(`INSERT INTO solana_signed_operations
      (operation_id, signed, signature, blockhash, last_valid_block_height)
      VALUES (?, ?, ?, ?, ?)`).run("expired", "old", oldSignature,
        Keypair.generate().publicKey.toBase58(), 100);
    const build = vi.fn(async () => new VersionedTransaction(new TransactionMessage({
      payerKey: wallet.publicKey, recentBlockhash: newBlockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey,
        toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    }).compileToV0Message()));
    const signature = await sender.execute("expired", build);
    expect(signature).not.toBe(oldSignature);
    expect(build).toHaveBeenCalledOnce();
    expect(calls).toEqual(["status", "finalized", "status", "status"]);
    expect((store.db.prepare(`SELECT signature FROM solana_signed_operations
      WHERE operation_id = 'expired'`).get() as { signature: string }).signature).toBe(signature);
    store.close();
  });
});
