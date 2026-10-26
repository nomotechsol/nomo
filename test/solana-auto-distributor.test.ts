import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Store } from "../src/store.js";
import { SolanaAutoDistributor } from "../src/execution/solana-auto-distributor.js";
import bs58 from "bs58";

describe("automatic Solana holder distribution", () => {
  it("sends several holders in each journalled transaction and does not resend after restart", async () => {
    const folder = mkdtempSync(join(tmpdir(), "nomo-payout-"));
    const file = join(folder, "db.sqlite");
    try {
      const store = new Store(file);
      const mint = Keypair.generate().publicKey;
      const reward = Keypair.generate();
      const holders = Array.from({ length: 5 }, () => Keypair.generate().publicKey.toBase58());
      store.addCandidate({ chain: "sol", launchpad: "pumpfun", token: mint.toBase58(),
        pool: Keypair.generate().publicKey.toBase58(), graduationTx: "purchase", graduatedAt: 1 });
      const id = `sol:pumpfun:${mint.toBase58()}:purchase`;
      store.updateCandidate(id, "eligible", []);
      store.startJob(id);
      store.recordRound({ candidateId: id, purchaseTx: "buy", receivedAtoms: 700n,
        rewardDecimals: 6, snapshotSlot: 123, holders: holders.map((solWallet) =>
          ({ solWallet, rawBalance: 1n })) });
      store.advanceJob(id, "reserved", "recorded", {});
      store.publishRound(id, "root", "backend:publish", reward.publicKey.toBase58(), undefined, "push");
      const mintData = Buffer.alloc(MINT_SIZE);
      MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: reward.publicKey, supply: 700n,
        decimals: 6, isInitialized: true, freezeAuthorityOption: 0,
        freezeAuthority: reward.publicKey }, mintData);
      const sent: VersionedTransaction[] = [];
      const rpc = {
        getAccountInfo: vi.fn(async () => ({ data: mintData, owner: TOKEN_PROGRAM_ID,
          executable: false, lamports: 1_000_000, rentEpoch: 0 })),
        getTokenAccountBalance: async () => ({ value: { amount: "700" } }),
        getMultipleAccountsInfo: async (addresses: unknown[]) => addresses.map(() => null),
        getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 500 }),
        getFeeForMessage: async () => ({ value: 5000 }),
        getMinimumBalanceForRentExemption: async () => 2_000_000,
        getBalance: async () => 100_000_000,
        getSignatureStatuses: async () => ({ value: [null] }),
        getBlockHeight: async () => 100,
        simulateTransaction: async () => ({ value: { err: null } }),
        sendRawTransaction: vi.fn(async (bytes: Uint8Array) => {
          const transaction = VersionedTransaction.deserialize(bytes);
          sent.push(transaction); return bs58.encode(transaction.signatures[0]!);
        }),
        confirmTransaction: async () => ({ value: { err: null } }),
      } as unknown as Connection;
      const signer = { publicKey: reward.publicKey, async sign(tx: VersionedTransaction) {
        tx.sign([reward]); return tx;
      } };
      const first = new SolanaAutoDistributor(store, rpc, signer);
      const recordSent = store.markSolanaPayoutBatchSent.bind(store);
      store.markSolanaPayoutBatchSent = () => { throw new Error("simulated restart after confirmation"); };
      await expect(first.tick()).rejects.toThrow("simulated restart");
      store.markSolanaPayoutBatchSent = recordSent;
      expect(sent).toHaveLength(1);
      expect(TransactionMessage.decompile(sent[0]!.message).instructions).toHaveLength(8);
      store.close();
      const reopened = new Store(file);
      const second = new SolanaAutoDistributor(reopened, rpc, signer);
      expect(await second.tick()).toBeTruthy();
      expect(sent).toHaveLength(1);
      expect(await second.tick()).toBeTruthy();
      expect(sent).toHaveLength(2);
      expect(TransactionMessage.decompile(sent[1]!.message).instructions).toHaveLength(2);
      expect(await second.tick()).toBeUndefined();
      expect(sent).toHaveLength(2);
      const firstPage = reopened.solanaPayoutBatchPage(1);
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.items[0]?.recipientCount).toBe(1);
      expect(firstPage.items[0]?.signature).toBeTruthy();
      expect(firstPage.nextCursor).toBeTruthy();
      const olderPage = reopened.solanaPayoutBatchPage(1, firstPage.nextCursor!);
      expect(olderPage.items[0]?.recipientCount).toBe(4);
      expect(olderPage.nextCursor).toBeNull();
      for (const wallet of holders) expect(reopened.getSolanaPayout(id, wallet)?.state).toBe("sent");
      reopened.close();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
