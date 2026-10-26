import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAccountLenForMint, getAssociatedTokenAddressSync,
  getMint } from "@solana/spl-token";
import { Store } from "../store.js";
import type { SolanaTransactionSigner } from "./solana-buy.js";
import { SolanaOperationSender } from "./solana-sender.js";

/** Pushes one durable batch at a time. The reward wallet pays ATA rent and transaction fees. */
export class SolanaAutoDistributor {
  private readonly sender: SolanaOperationSender;
  private running = false;

  constructor(private readonly store: Store, private readonly connection: Connection,
    private readonly rewardSigner: SolanaTransactionSigner) {
    this.sender = new SolanaOperationSender(store, connection, rewardSigner);
  }

  async tick(): Promise<string | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      const batch = this.store.nextSolanaPayoutBatch();
      if (!batch) return undefined;
      const candidate = this.store.getCandidate(batch.candidateId)?.candidate;
      const published = this.store.getPublishedRound(batch.candidateId);
      if (candidate?.chain !== "sol" || published?.deliveryMode !== "push" ||
          published.claimTarget !== this.rewardSigner.publicKey.toBase58())
        throw new Error("Solana payout batch does not match its published reward vault");
      const signature = await this.sender.execute(`payout:${batch.id}`, async () => {
        const mint = new PublicKey(candidate.token);
        const mintInfo = await this.connection.getAccountInfo(mint, "confirmed");
        if (!mintInfo || (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) &&
            !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)))
          throw new Error("Unsupported Solana reward mint");
        const tokenProgram = mintInfo.owner;
        const mintState = await getMint(this.connection, mint, "confirmed", tokenProgram);
        const source = getAssociatedTokenAddressSync(mint, this.rewardSigner.publicKey, false, tokenProgram);
        const destinations = batch.rows.map((row) => {
          const owner = new PublicKey(row.solWallet);
          if (owner.equals(this.rewardSigner.publicKey) || row.rewardAtoms <= 0n ||
              row.rewardAtoms > 0xffff_ffff_ffff_ffffn)
            throw new Error("Invalid Solana payout recipient or amount");
          return { ...row, owner, ata: getAssociatedTokenAddressSync(mint, owner, true, tokenProgram) };
        });
        const [sourceBalance, destinationAccounts, latest] = await Promise.all([
          this.connection.getTokenAccountBalance(source, "confirmed"),
          this.connection.getMultipleAccountsInfo(destinations.map((row) => row.ata), "confirmed"),
          this.connection.getLatestBlockhash("confirmed"),
        ]);
        const amount = destinations.reduce((sum, row) => sum + row.rewardAtoms, 0n);
        if (BigInt(sourceBalance.value.amount) < amount) throw new Error("Solana reward vault is underfunded");
        const instructions = destinations.flatMap((row) => [
          createAssociatedTokenAccountIdempotentInstruction(this.rewardSigner.publicKey,
            row.ata, row.owner, mint, tokenProgram),
          createTransferCheckedInstruction(source, mint, row.ata, this.rewardSigner.publicKey,
            row.rewardAtoms, mintState.decimals, [], tokenProgram),
        ]);
        const message = new TransactionMessage({ payerKey: this.rewardSigner.publicKey,
          recentBlockhash: latest.blockhash, instructions }).compileToV0Message();
        const unsigned = new VersionedTransaction(message);
        if (unsigned.serialize().length > 1232) throw new Error("Solana payout batch exceeds transaction size");
        const [fee, rent, solBalance] = await Promise.all([
          this.connection.getFeeForMessage(message, "confirmed"),
          this.connection.getMinimumBalanceForRentExemption(getAccountLenForMint(mintState), "confirmed"),
          this.connection.getBalance(this.rewardSigner.publicKey, "confirmed"),
        ]);
        const missing = destinationAccounts.filter((account) => !account).length;
        if (fee.value === null || solBalance < fee.value + rent * missing + 100_000)
          throw new Error("Solana reward wallet needs SOL for payout fees and token accounts");
        return unsigned;
      });
      this.store.markSolanaPayoutBatchSent(batch.id, signature);
      return signature;
    } finally { this.running = false; }
  }
}
