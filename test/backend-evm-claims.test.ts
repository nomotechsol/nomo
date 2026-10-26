import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { BackendBscClaims } from "../src/claims/bsc-transfer.js";
import type { BackendEvmSigner } from "../src/execution/backend-evm-signer.js";
import { candidateKey, type Candidate } from "../src/domain.js";
import { Store } from "../src/store.js";

describe.each([
  { chain: "bsc" as const, chainId: 56, launchpad: "flap_tax" as const },
  { chain: "robinhood" as const, chainId: 4663, launchpad: "pons_v2" as const },
])("$chain backend reward claim", ({ chain, chainId, launchpad }) => {
  it("requires a matching gas reimbursement and pays the linked wallet only once", async () => {
    const store = new Store(":memory:");
    try {
      const solWallet = "holder-solana-wallet";
      const recipient = privateKeyToAccount(generatePrivateKey()).address;
      const reward = { account: privateKeyToAccount(generatePrivateKey()) } as BackendEvmSigner;
      const candidate: Candidate = { chain, launchpad, token: privateKeyToAccount(generatePrivateKey()).address,
        pool: privateKeyToAccount(generatePrivateKey()).address, graduationTx: "0xabc", graduatedAt: Date.now() };
      const id = candidateKey(candidate);
      store.addCandidate(candidate);
      store.updateCandidate(id, "eligible", []);
      store.startJob(id);
      store.recordRound({ candidateId: id, purchaseTx: "0xbuy", receivedAtoms: 700n,
        rewardDecimals: 18, snapshotSlot: 100, holders: [{ solWallet, rawBalance: 1_000_000n }] });
      store.advanceJob(id, "reserved", "recorded", {});
      store.publishRound(id, "root", "backend:publish", reward.account.address, chainId);
      store.addLinkChallenge({ id: "local-challenge", solWallet, evmWallet: recipient,
        message: "local", expiresAt: Date.now() + 60_000 });
      store.consumeLinkChallenge("local-challenge");

      const claims = new BackendBscClaims(store, "http://127.0.0.1:1", reward, chain);
      let credited = false;
      const payment = { chainId, from: recipient, to: reward.account.address,
        value: 1_000_000_000_000_000_000n, input: "0x" };
      const client = {
        estimateGas: vi.fn(async () => 50_000n), getGasPrice: vi.fn(async () => 1_000_000_000n),
        getTransaction: vi.fn(async () => payment),
        getTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 100n })),
        getBlockNumber: vi.fn(async () => 103n),
        getBlock: vi.fn(async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) })),
        readContract: vi.fn(async () => credited ? 700n : 0n),
      };
      const execute = vi.fn(async () => { credited = true; return "0x1234" as Hex; });
      Object.assign(claims as unknown as { sender: unknown }, { sender: { client, execute } });

      const quote = await claims.prepare(id, solWallet);
      expect(quote.chainId).toBe(chainId);
      expect(quote.recipient).toBe(recipient);
      expect(quote.rewardAtoms).toBe("700");
      expect(BigInt(quote.feeWei)).toBeGreaterThan(0n);
      const hash = `0x${"ab".repeat(32)}` as Hex;
      payment.from = reward.account.address;
      await expect(claims.finalize(id, solWallet, hash)).rejects.toThrow("does not match");
      expect(execute).not.toHaveBeenCalled();
      payment.from = recipient;
      expect(await claims.finalize(id, solWallet, hash)).toEqual({ claimed: true, payoutHash: "0x1234" });
      expect(await claims.finalize(id, solWallet, hash)).toEqual({ claimed: true, payoutHash: "0x1234" });
      expect(execute).toHaveBeenCalledTimes(1);
      await expect(claims.prepare(id, solWallet)).rejects.toThrow("already claimed");
    } finally { store.close(); }
  });
});
