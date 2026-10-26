import { createPublicClient, http, keccak256, type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import { robinhood } from "../evm/scanner.js";
import { Store } from "../store.js";
import { BackendEvmSigner } from "./backend-evm-signer.js";

type Pending = { signed: Hex; hash: Hex; confirmed: number };

/** Persist signed bytes before submission so retry cannot create a second EVM transaction. */
export class EvmOperationSender {
  readonly client;

  constructor(private readonly store: Store, rpcUrl: string, private readonly signer: BackendEvmSigner,
    private readonly chain: "bsc" | "robinhood" = "bsc") {
    this.client = createPublicClient({ chain: chain === "bsc" ? bsc : robinhood, transport: http(rpcUrl) });
    store.db.exec(`CREATE TABLE IF NOT EXISTS evm_signed_operations (
      operation_id TEXT PRIMARY KEY, signed TEXT NOT NULL, hash TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0)`);
  }

  async execute(operationId: string, transaction?: { to: Address; data: Hex; value: bigint }): Promise<Hex> {
    if (!operationId) throw new Error("EVM operation ID is required");
    let row = this.store.db.prepare(`SELECT signed, hash, confirmed FROM evm_signed_operations
      WHERE operation_id = ?`).get(operationId) as Pending | undefined;
    if (!row) {
      if (!transaction) throw new Error("Missing unsigned EVM operation");
      const account = this.signer.account;
      const [gasPrice, nonce, estimated] = await Promise.all([
        this.client.getGasPrice(),
        this.client.getTransactionCount({ address: account.address, blockTag: "pending" }),
        this.client.estimateGas({ account: account.address, ...transaction }),
      ]);
      const signed = await account.signTransaction({ chainId: this.chain === "bsc" ? 56 : 4663,
        type: "legacy", to: transaction.to,
        data: transaction.data, value: transaction.value, nonce, gasPrice,
        gas: estimated * 125n / 100n + 20_000n });
      row = { signed, hash: keccak256(signed), confirmed: 0 };
      this.store.db.prepare(`INSERT INTO evm_signed_operations (operation_id, signed, hash)
        VALUES (?, ?, ?)`).run(operationId, row.signed, row.hash);
    }
    if (row.confirmed) return row.hash;
    let receipt;
    try { receipt = await this.client.getTransactionReceipt({ hash: row.hash }); }
    catch { /* not mined yet */ }
    if (!receipt) {
      try { await this.client.sendRawTransaction({ serializedTransaction: row.signed }); }
      catch (error) {
        // A previously sent raw transaction may already be in the mempool. Confirm by hash below.
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (!message.includes("already known") && !message.includes("known transaction")) throw error;
      }
      receipt = await this.client.waitForTransactionReceipt({ hash: row.hash, timeout: 90_000 });
    }
    if (receipt.status !== "success") throw new Error(`EVM operation reverted: ${row.hash}`);
    this.store.db.prepare("UPDATE evm_signed_operations SET confirmed = 1 WHERE operation_id = ?")
      .run(operationId);
    return row.hash;
  }

  has(operationId: string): boolean {
    return Boolean(this.store.db.prepare("SELECT 1 FROM evm_signed_operations WHERE operation_id = ?")
      .get(operationId));
  }
}
