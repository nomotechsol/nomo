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
});
