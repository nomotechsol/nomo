import { PublicKey } from "@solana/web3.js";
import { Store } from "../store.js";

export function claimProof(store: Store, candidateId: string, wallet: string) {
  const solWallet = new PublicKey(wallet).toBase58();
  const candidate = store.getCandidate(candidateId)?.candidate;
  const round = store.getRound(candidateId);
  const published = store.getPublishedRound(candidateId);
  if (!candidate || !round || !published || !published.claimTarget || published.deliveryMode !== "claim") return undefined;
  const allocations = store.allocationsForRound(candidateId);
  if (candidate.chain === "sol") {
    const claim = allocations.find((item) => item.solWallet === solWallet);
    return claim && { chain: candidate.chain, candidateId, token: candidate.token,
      rewardWallet: published.claimTarget, amount: claim.rewardAtoms.toString(),
      claimed: store.getSolanaClaim(candidateId, solWallet)?.state === "claimed" };
  }
  return undefined;
}
