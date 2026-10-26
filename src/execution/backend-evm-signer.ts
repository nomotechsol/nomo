import { readFileSync, statSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

/** Custodial backend EVM key kept in a private file outside the repository. */
export class BackendEvmSigner {
  readonly account;

  private constructor(secret: `0x${string}`) { this.account = privateKeyToAccount(secret); }

  static fromFile(path: string): BackendEvmSigner {
    if (!path) throw new Error("EVM key path is required");
    const stats = statSync(path);
    if (!stats.isFile() || (stats.mode & 0o077) !== 0)
      throw new Error("EVM key file must be private (chmod 600)");
    const secret = readFileSync(path, "utf8").trim();
    if (!/^0x[\da-fA-F]{64}$/.test(secret)) throw new Error("EVM key file must contain a 32-byte hex key");
    return new BackendEvmSigner(secret as `0x${string}`);
  }
}
