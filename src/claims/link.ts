import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { getAddress, isAddress, verifyMessage } from "viem";
import { Store } from "../store.js";

export function createWalletLinkChallenge(store: Store, solWallet: string, evmWallet: string, origin: string):
  { id: string; message: string; expiresAt: number } {
  const sol = new PublicKey(solWallet).toBase58();
  if (!isAddress(evmWallet)) throw new Error("Invalid EVM wallet");
  const evm = getAddress(evmWallet);
  const id = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + 5 * 60_000;
  const message = `NOMO wallet link\nOrigin: ${origin}\nSolana: ${sol}\nEVM: ${evm}\nNonce: ${id}\nExpires: ${new Date(expiresAt).toISOString()}`;
  store.addLinkChallenge({ id, solWallet: sol, evmWallet: evm, message, expiresAt });
  return { id, message, expiresAt };
}

export async function confirmWalletLink(store: Store, id: string, solSignatureBase64: string,
  evmSignature: `0x${string}`): Promise<{ solWallet: string; evmWallet: string }> {
  const challenge = store.getLinkChallenge(id);
  if (!challenge || challenge.used || challenge.expiresAt <= Date.now()) throw new Error("Link challenge expired or already used");
  const solSignature = Buffer.from(solSignatureBase64, "base64");
  if (solSignature.length !== 64 || !nacl.sign.detached.verify(
    new TextEncoder().encode(challenge.message), solSignature, new PublicKey(challenge.solWallet).toBytes()))
    throw new Error("Invalid Solana wallet signature");
  let evmValid = false;
  if (/^0x[0-9a-fA-F]{130}$/.test(evmSignature)) {
    try { evmValid = await verifyMessage({ address: challenge.evmWallet as `0x${string}`,
      message: challenge.message, signature: evmSignature }); }
    catch { evmValid = false; }
  }
  if (!evmValid)
    throw new Error("Invalid EVM wallet signature");
  store.consumeLinkChallenge(id);
  return { solWallet: challenge.solWallet, evmWallet: challenge.evmWallet };
}
