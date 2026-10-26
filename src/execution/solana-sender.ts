import bs58 from "bs58";
import nacl from "tweetnacl";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { Store } from "../store.js";
import type { SolanaTransactionSigner } from "./solana-buy.js";
import { expiredSignatureAbsent } from "./solana-expiry.js";

type PendingOperation = { signed: string; signature: string; blockhash: string;
  lastValidBlockHeight: number; confirmed: number };

/** Durable, idempotent submission for non-purchase Solana operations. */
export class SolanaOperationSender {
  constructor(private readonly store: Store, private readonly connection: Connection,
    private readonly signer: SolanaTransactionSigner) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS solana_signed_operations (
      operation_id TEXT PRIMARY KEY, signed TEXT NOT NULL, signature TEXT NOT NULL,
      blockhash TEXT NOT NULL, last_valid_block_height INTEGER NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0)`);
  }

  async execute(operationId: string, build: () => Promise<VersionedTransaction>): Promise<string> {
    return this.executeAttempt(operationId, build, true);
  }

  private async executeAttempt(operationId: string, build: () => Promise<VersionedTransaction>,
    allowExpiredRetry: boolean): Promise<string> {
    if (!operationId) throw new Error("Solana operation ID is required");
    let row = this.store.db.prepare(`SELECT signed, signature, blockhash,
      last_valid_block_height AS lastValidBlockHeight, confirmed
      FROM solana_signed_operations WHERE operation_id = ?`).get(operationId) as PendingOperation | undefined;
    if (!row) {
      const unsigned = await build();
      const latest = await this.connection.getLatestBlockhash("confirmed");
      unsigned.message.recentBlockhash = latest.blockhash;
      const message = Buffer.from(unsigned.message.serialize());
      const signed = await this.signer.sign(unsigned);
      if (!Buffer.from(signed.message.serialize()).equals(message) ||
          !signed.message.staticAccountKeys[0]?.equals(this.signer.publicKey) ||
          signed.signatures.length !== 1 ||
          !nacl.sign.detached.verify(message, signed.signatures[0]!, this.signer.publicKey.toBytes()))
        throw new Error("Signer changed the Solana operation or returned an invalid signature");
      row = { signed: Buffer.from(signed.serialize()).toString("base64"),
        signature: bs58.encode(signed.signatures[0]!), blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight, confirmed: 0 };
      this.store.db.prepare(`INSERT INTO solana_signed_operations
        (operation_id, signed, signature, blockhash, last_valid_block_height)
        VALUES (?, ?, ?, ?, ?)`).run(operationId, row.signed, row.signature,
        row.blockhash, row.lastValidBlockHeight);
    }
    if (row.confirmed) return row.signature;
    const status = (await this.connection.getSignatureStatuses([row.signature],
      { searchTransactionHistory: true })).value[0];
    if (status?.err) throw new Error(`Solana operation failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus !== "confirmed" && status?.confirmationStatus !== "finalized") {
      if (await this.connection.getBlockHeight("confirmed") > row.lastValidBlockHeight) {
        if (allowExpiredRetry && await expiredSignatureAbsent(this.connection, row.signature,
          row.lastValidBlockHeight)) {
          this.store.db.prepare(`DELETE FROM solana_signed_operations
            WHERE operation_id = ? AND signature = ? AND confirmed = 0`).run(operationId, row.signature);
          return this.executeAttempt(operationId, build, false);
        }
        throw new Error("Signed Solana operation expired; final reconciliation required");
      }
      const transaction = VersionedTransaction.deserialize(Buffer.from(row.signed, "base64"));
      const simulation = await this.connection.simulateTransaction(transaction,
        { sigVerify: true, commitment: "confirmed" });
      if (simulation.value.err) throw new Error(`Solana operation simulation failed: ${JSON.stringify(simulation.value.err)}`);
      const submitted = await this.connection.sendRawTransaction(transaction.serialize(),
        { skipPreflight: false, maxRetries: 30 });
      if (submitted !== row.signature) throw new Error("Solana RPC returned a different operation signature");
      const receipt = await this.connection.confirmTransaction({ signature: row.signature,
        blockhash: row.blockhash, lastValidBlockHeight: row.lastValidBlockHeight }, "confirmed");
      if (receipt.value.err) throw new Error(`Solana operation failed: ${JSON.stringify(receipt.value.err)}`);
    }
    this.store.db.prepare("UPDATE solana_signed_operations SET confirmed = 1 WHERE operation_id = ?")
      .run(operationId);
    return row.signature;
  }
}
