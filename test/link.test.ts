import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletLinkChallenge, confirmWalletLink } from "../src/claims/link.js";
import { Store } from "../src/store.js";

describe("wallet linking", () => {
  it("requires both wallet signatures and consumes the nonce once", async () => {
    const store = new Store(":memory:");
    const sol = nacl.sign.keyPair();
    const evm = privateKeyToAccount(generatePrivateKey());
    const solWallet = bs58.encode(sol.publicKey);
    const challenge = createWalletLinkChallenge(store, solWallet, evm.address, "https://nomo.example");
    const solSignatureBase64 = Buffer.from(nacl.sign.detached(
      new TextEncoder().encode(challenge.message), sol.secretKey)).toString("base64");
    const evmSignature = await evm.signMessage({ message: challenge.message });
    await expect(confirmWalletLink(store, challenge.id, solSignatureBase64,
      `0x${"00".repeat(65)}`)).rejects.toThrow("Invalid EVM");
    await expect(confirmWalletLink(store, challenge.id, solSignatureBase64, evmSignature))
      .resolves.toEqual({ solWallet, evmWallet: evm.address });
    expect(store.getWalletLink(solWallet)?.evmWallet).toBe(evm.address);
    await expect(confirmWalletLink(store, challenge.id, solSignatureBase64, evmSignature))
      .rejects.toThrow("already used");
    store.close();
  });
});
