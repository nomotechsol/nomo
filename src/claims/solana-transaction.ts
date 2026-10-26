import bs58 from "bs58";
import nacl from "tweetnacl";
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction, getAccountLenForMint, getAssociatedTokenAddressSync,
  getMint } from "@solana/spl-token";
import { Store } from "../store.js";
import type { SolanaTransactionSigner } from "../execution/solana-buy.js";

export class BackendSolanaClaims {
  constructor(private readonly store: Store, private readonly connection: Connection,
    private readonly rewardSigner: SolanaTransactionSigner,
    private readonly cluster: "mainnet" | "devnet" | "localnet") {}

  async prepare(candidateId: string, wallet: string) {
    const claimant = new PublicKey(wallet);
    const solWallet = claimant.toBase58();
    if (claimant.equals(this.rewardSigner.publicKey)) throw new Error("Cannot claim to reward wallet");
    const candidate = this.store.getCandidate(candidateId)?.candidate;
    const round = this.store.getRound(candidateId);
    const published = this.store.getPublishedRound(candidateId);
    const allocation = this.store.allocationsForWallet(solWallet)
      .find((row) => row.candidateId === candidateId);
    if (candidate?.chain !== "sol" || !round || !published || published.deliveryMode !== "claim" ||
        published.claimTarget !== this.rewardSigner.publicKey.toBase58() ||
        !allocation || BigInt(allocation.rewardAtoms) <= 0n)
      throw new Error("Solana allocation is not ready");
    const old = this.store.getSolanaClaim(candidateId, solWallet);
    if (old?.state === "claimed") throw new Error("Allocation was already claimed");
    if (old) {
      if (await this.confirmed(old.signature)) {
        this.store.markSolanaClaimed(candidateId, solWallet, old.signature);
        throw new Error("Allocation was already claimed");
      }
      // A finalized block height past expiry prevents this signed transfer landing later.
      if (await this.connection.getBlockHeight("finalized") <= old.lastValidBlockHeight)
        return this.response(old.transactionBase64, old.lastValidBlockHeight);
    }
    const mint = new PublicKey(candidate.token);
    const mintAccount = await this.connection.getAccountInfo(mint, "confirmed");
    if (!mintAccount || (!mintAccount.owner.equals(TOKEN_PROGRAM_ID) &&
        !mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID))) throw new Error("Unsupported reward token mint");
    const tokenProgram = mintAccount.owner;
    const mintState = await getMint(this.connection, mint, "confirmed", tokenProgram);
    const decimals = mintState.decimals;
    const source = getAssociatedTokenAddressSync(mint, this.rewardSigner.publicKey, false, tokenProgram);
    const recipient = getAssociatedTokenAddressSync(mint, claimant, false, tokenProgram);
    const amount = BigInt(allocation.rewardAtoms);
    if (amount <= 0n || amount > 0xffff_ffff_ffff_ffffn) throw new Error("Invalid reward amount");
    const [sourceInfo, recipientInfo, latest] = await Promise.all([
      this.connection.getTokenAccountBalance(source, "confirmed"),
      this.connection.getAccountInfo(recipient, "confirmed"),
      this.connection.getLatestBlockhash("confirmed"),
    ]);
    if (BigInt(sourceInfo.value.amount) < amount) throw new Error("Reward wallet is underfunded");
    const rent = recipientInfo ? 0 : await this.connection.getMinimumBalanceForRentExemption(
      getAccountLenForMint(mintState), "confirmed");
    const createRecipient = recipientInfo ? [] : [createAssociatedTokenAccountInstruction(
      this.rewardSigner.publicKey, recipient, claimant, mint, tokenProgram)];
    const transferReward = createTransferCheckedInstruction(source, mint, recipient,
      this.rewardSigner.publicKey, amount, decimals, [], tokenProgram);
    // The reward wallet pays the network/ATA fees and the claimant reimburses
    // those lamports in the same atomic transaction. Both use ordinary wallets.
    const buildMessage = (reimbursement: number) => new TransactionMessage({
      payerKey: this.rewardSigner.publicKey, recentBlockhash: latest.blockhash,
      instructions: [...createRecipient, transferReward,
        SystemProgram.transfer({ fromPubkey: claimant, toPubkey: this.rewardSigner.publicKey,
          lamports: reimbursement })],
    }).compileToV0Message();
    const fee = (await this.connection.getFeeForMessage(buildMessage(0), "confirmed")).value;
    if (fee === null) throw new Error("Cannot estimate Solana claim fee");
    const unsigned = new VersionedTransaction(buildMessage(fee + rent));
    const message = Buffer.from(unsigned.message.serialize());
    const signed = await this.rewardSigner.sign(unsigned);
    const rewardIndex = signed.message.staticAccountKeys.findIndex((key) => key.equals(this.rewardSigner.publicKey));
    if (!Buffer.from(signed.message.serialize()).equals(message) || rewardIndex < 0 ||
        !nacl.sign.detached.verify(message, signed.signatures[rewardIndex]!, this.rewardSigner.publicKey.toBytes()))
      throw new Error("Backend signer returned an invalid claim transaction");
    const simulation = await this.connection.simulateTransaction(signed,
      { sigVerify: false, commitment: "confirmed" });
    if (simulation.value.err) throw new Error(`Solana claim simulation failed: ${JSON.stringify(simulation.value.err)}`);
    const transactionBase64 = Buffer.from(signed.serialize()).toString("base64");
    const signature = bs58.encode(signed.signatures[rewardIndex]!);
    const saved = this.store.savePreparedSolanaClaim({ candidateId, solWallet, transactionBase64,
      signature, lastValidBlockHeight: latest.lastValidBlockHeight }, old?.signature);
    if (!saved) {
      const current = this.store.getSolanaClaim(candidateId, solWallet);
      if (!current || current.state === "claimed") throw new Error("Allocation was already claimed");
      return this.response(current.transactionBase64, current.lastValidBlockHeight);
    }
    return this.response(transactionBase64, latest.lastValidBlockHeight);
  }

  async finalize(candidateId: string, wallet: string, signature: string) {
    const solWallet = new PublicKey(wallet).toBase58();
    const row = this.store.getSolanaClaim(candidateId, solWallet);
    if (!row || row.signature !== signature) throw new Error("Unknown claim transaction");
    if (row.state === "claimed") return { claimed: true, signature };
    if (!await this.confirmed(signature)) throw new Error("Claim is not confirmed on Solana");
    this.store.markSolanaClaimed(candidateId, solWallet, signature);
    return { claimed: true, signature };
  }

  async reconcileWallet(wallet: string): Promise<void> {
    const solWallet = new PublicKey(wallet).toBase58();
    const pending = this.store.pendingSolanaClaimsForWallet(solWallet);
    if (pending.length === 0) return;
    const statuses = (await this.connection.getSignatureStatuses(pending.map((row) => row.signature),
      { searchTransactionHistory: true })).value;
    pending.forEach((row, index) => {
      const status = statuses[index];
      if (!status?.err && (status?.confirmationStatus === "confirmed" ||
          status?.confirmationStatus === "finalized"))
        this.store.markSolanaClaimed(row.candidateId, solWallet, row.signature);
    });
  }

  private async confirmed(signature: string): Promise<boolean> {
    const status = (await this.connection.getSignatureStatuses([signature],
      { searchTransactionHistory: true })).value[0];
    if (status?.err) throw new Error("Solana claim transaction failed");
    return status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized";
  }

  private response(transactionBase64: string, lastValidBlockHeight: number) {
    return { chain: `solana:${this.cluster}`, transactionBase64, lastValidBlockHeight };
  }
}
