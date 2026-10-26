import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { BackendSolanaSigner } from "../src/execution/backend-solana-signer.js";

describe("backend Solana signer", () => {
  it("requires a private keypair file and signs the exact transaction message", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nomo-signer-"));
    const path = join(directory, "treasury.json");
    const keypair = Keypair.generate();
    try {
      writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
      chmodSync(path, 0o644);
      expect(() => BackendSolanaSigner.fromFile(path)).toThrow(/chmod 600/);
      chmodSync(path, 0o600);
      const signer = BackendSolanaSigner.fromFile(path);
      expect(signer.publicKey.equals(keypair.publicKey)).toBe(true);
      const message = new TransactionMessage({ payerKey: keypair.publicKey,
        recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [
          SystemProgram.transfer({ fromPubkey: keypair.publicKey,
            toPubkey: Keypair.generate().publicKey, lamports: 1 }),
        ] }).compileToV0Message();
      const transaction = await signer.sign(new VersionedTransaction(message));
      expect(nacl.sign.detached.verify(message.serialize(), transaction.signatures[0]!,
        keypair.publicKey.toBytes())).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
