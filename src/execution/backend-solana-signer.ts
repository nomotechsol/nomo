import { readFileSync, statSync } from "node:fs";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import type { SolanaTransactionSigner } from "./solana-buy.js";

/** A backend-owned keypair file. The secret is never returned by an API or written to SQLite. */
export class BackendSolanaSigner implements SolanaTransactionSigner {
  readonly publicKey;
  private constructor(private readonly keypair: Keypair) { this.publicKey = keypair.publicKey; }

  static fromFile(path: string): BackendSolanaSigner {
    if (!path) throw new Error("Solana keypair path is required");
    const stats = statSync(path);
    if (!stats.isFile() || (stats.mode & 0o077) !== 0)
      throw new Error("Solana keypair file must be private (chmod 600)");
    const bytes: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(bytes) || bytes.length !== 64 ||
        bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
      throw new Error("Solana keypair file must contain a 64-byte JSON array");
    return new BackendSolanaSigner(Keypair.fromSecretKey(Uint8Array.from(bytes)));
  }

  async sign(transaction: VersionedTransaction): Promise<VersionedTransaction> {
    transaction.sign([this.keypair]);
    return transaction;
  }
}
