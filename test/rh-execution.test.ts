import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTransaction } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { BackendBscClaims } from "../src/claims/bsc-transfer.js";
import { BackendEvmSigner } from "../src/execution/backend-evm-signer.js";
import { EvmOperationSender } from "../src/execution/evm-sender.js";
import { Store } from "../src/store.js";
import { candidateKey } from "../src/domain.js";

describe("Robinhood execution isolation", () => {
  it("signs the backend purchase on chain 4663, never BNB chain 56", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nomo-rh-test-"));
    const keyPath = join(dir, "key");
    writeFileSync(keyPath, generatePrivateKey(), { mode: 0o600 });
    const store = new Store(":memory:");
    try {
      const signer = BackendEvmSigner.fromFile(keyPath);
      const sender = new EvmOperationSender(store, "http://unused", signer, "robinhood");
      Object.assign(sender, { client: {
        getGasPrice: async () => 1_000_000n,
        getTransactionCount: async () => 0,
        estimateGas: async () => 21_000n,
        getTransactionReceipt: async () => ({ status: "success" }),
      } });
      const hash = await sender.execute("robinhood:purchase:one", {
        to: "0x1111111111111111111111111111111111111111", data: "0x", value: 1n });
      const row = store.db.prepare("SELECT signed, hash, confirmed FROM evm_signed_operations WHERE operation_id = ?")
        .get("robinhood:purchase:one") as { signed: `0x${string}`; hash: string; confirmed: number };
      expect(hash).toBe(row.hash);
      expect(row.confirmed).toBe(1);
      expect(parseTransaction(row.signed).chainId).toBe(4663);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps RH claim records separate from BNB claims", () => {
    const dir = mkdtempSync(join(tmpdir(), "nomo-rh-test-"));
    const keyPath = join(dir, "key");
    writeFileSync(keyPath, generatePrivateKey(), { mode: 0o600 });
    const store = new Store(":memory:");
    try {
      const signer = BackendEvmSigner.fromFile(keyPath);
      const rh = new BackendBscClaims(store, "http://unused", signer, "robinhood");
      const bsc = new BackendBscClaims(store, "http://unused", signer);
      store.db.prepare(`INSERT INTO rh_claims
        (candidate_id,sol_wallet,recipient,reimbursement_hash,before_balance,payout_hash,state)
        VALUES ('rh-round','sol-wallet',?,'0xrefund','0','0xpayout','claimed')`)
        .run(signer.account.address);
      expect(rh.getClaim("rh-round", "sol-wallet")?.claimed).toBe(true);
      expect(bsc.getClaim("rh-round", "sol-wallet")).toBeUndefined();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("prepares a chain-4663 gas-paid claim for a published RH allocation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nomo-rh-test-"));
    const keyPath = join(dir, "key");
    writeFileSync(keyPath, generatePrivateKey(), { mode: 0o600 });
    const store = new Store(":memory:");
    try {
      const signer = BackendEvmSigner.fromFile(keyPath);
      const recipient = "0x2222222222222222222222222222222222222222";
      const wallet = "11111111111111111111111111111111";
      const candidate = { chain: "robinhood" as const, launchpad: "pons_v2" as const,
        token: "0x1111111111111111111111111111111111111111",
        pool: `0x${"33".repeat(32)}`, quoteToken: "0x0000000000000000000000000000000000000000",
        graduationTx: `0x${"44".repeat(32)}`, graduatedAt: 1 };
      const id = candidateKey(candidate);
      store.addCandidate(candidate);
      store.db.prepare(`INSERT INTO rounds
        (candidate_id,purchase_tx,received_atoms,reward_decimals,snapshot_slot,created_at)
        VALUES (?,?,?,18,1,1)`).run(id, `0x${"55".repeat(32)}`, "1000");
      store.db.prepare(`INSERT INTO allocations (candidate_id,sol_wallet,reward_atoms)
        VALUES (?,?,?)`).run(id, wallet, "700");
      store.db.prepare(`INSERT INTO published_rounds
        (candidate_id,root,publish_tx,published_at,claim_target,chain_id)
        VALUES (?,?,?,1,?,4663)`).run(id, `0x${"66".repeat(32)}`, "backend:test", signer.account.address);
      store.db.prepare(`INSERT INTO wallet_links (sol_wallet,evm_wallet,linked_at)
        VALUES (?,?,1)`).run(wallet, recipient);
      const claims = new BackendBscClaims(store, "http://unused", signer, "robinhood");
      Object.assign(claims, { sender: { client: {
        estimateGas: async () => 50_000n,
        getGasPrice: async () => 1_000_000n,
      } } });
      const prepared = await claims.prepare(id, wallet);
      expect(prepared).toMatchObject({ chainId: 4663, recipient,
        gasWallet: signer.account.address, rewardAtoms: "700" });
      expect(BigInt(prepared.feeWei)).toBeGreaterThan(0n);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
