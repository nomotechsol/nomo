import bs58 from "bs58";
import nacl from "tweetnacl";
import { getAccount, getAssociatedTokenAddressSync, getMint, TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey, TransactionMessage,
  VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import type { Candidate } from "../domain.js";
import { Store } from "../store.js";
import { PumpPurchaseQuotes, RaydiumFundingQuotes, RaydiumRouteUnavailable,
  StonkPurchaseQuotes, type PumpNestedRoute } from "./solana-routes.js";

export interface SolanaTransactionSigner {
  readonly publicKey: PublicKey;
  /** Return this exact message signed by publicKey. No key material is handled by the buyer. */
  sign(transaction: VersionedTransaction): Promise<VersionedTransaction>;
}

type BuyPlan = {
  candidateToken: string;
  budgetLamports: string;
  kind: "pump_direct" | "pump_nested" | "stonk";
  path?: string[];
  quoteMint?: string;
  quoteBefore?: string;
  targetBefore: string;
  unsignedFunding: string[];
  fundingIndex: number;
  pending?: { index: number; transaction: string; signature: string; blockhash: string;
    lastValidBlockHeight: number };
  finalSignature?: string;
};

/**
 * Sends verified post-graduation Solana purchases and durably journals signed transactions.
 * The caller must supply a signer, snapshot/treasury stages and run ExecutionEngine.tick().
 * A pending signature is always reconciled before another transaction can be signed.
 */
export class SolanaBuyExecutor {
  private readonly raydium: RaydiumFundingQuotes;
  private readonly pumpQuotes: PumpPurchaseQuotes;
  private readonly stonkQuotes: StonkPurchaseQuotes;
  private readonly pumpExecution: PumpPurchaseQuotes;

  constructor(private readonly store: Store, private readonly quoteConnection: Connection,
    private readonly sendConnection: Connection, private readonly signer: SolanaTransactionSigner) {
    this.raydium = new RaydiumFundingQuotes(quoteConnection);
    this.pumpQuotes = new PumpPurchaseQuotes(quoteConnection, this.raydium);
    this.stonkQuotes = new StonkPurchaseQuotes(quoteConnection);
    this.pumpExecution = new PumpPurchaseQuotes(sendConnection, this.raydium);
  }

  async availableSolLamports(): Promise<bigint> {
    return BigInt(await this.sendConnection.getBalance(this.signer.publicKey, "confirmed"));
  }

  async buy(operationId: string, candidate: Candidate, budgetLamports: bigint): Promise<{
    tx: string; receivedAtoms: bigint; rewardDecimals: number }> {
    if (candidate.chain !== "sol" || !["pumpfun", "stonkfun"].includes(candidate.launchpad) ||
        budgetLamports <= 0n || budgetLamports > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Solana buyer requires a verified Pump.fun or StonkFun budget");
    const job = this.store.getActiveJob();
    if (!job || job.stage !== "snapshotted" || operationId !== `${job.candidateId}:buy` ||
        this.store.getCandidate(job.candidateId)?.candidate.token !== candidate.token)
      throw new Error("Purchase does not match the reserved journal job");
    let plan = job.data.buyPlan as BuyPlan | undefined;
    if (!plan) {
      plan = await this.preparePlan(candidate, budgetLamports);
      this.savePlan(job.candidateId, plan);
    }
    if (plan.candidateToken !== candidate.token || plan.budgetLamports !== budgetLamports.toString())
      throw new Error("Persisted Solana purchase plan differs from candidate or budget");

    while (plan.fundingIndex < plan.unsignedFunding.length) {
      const raw = plan.unsignedFunding[plan.fundingIndex];
      if (!raw) throw new Error("Missing funding transaction in purchase plan");
      const unsigned = VersionedTransaction.deserialize(Buffer.from(raw, "base64"));
      const signature = await this.sendStep(job.candidateId, plan, plan.fundingIndex, unsigned);
      if (plan.kind === "stonk" && plan.fundingIndex === plan.unsignedFunding.length - 1)
        plan.finalSignature = signature;
      plan.fundingIndex++;
      plan.pending = undefined;
      this.savePlan(job.candidateId, plan);
    }

    if (plan.kind !== "stonk" && !plan.finalSignature) {
      const quoteAtoms = plan.quoteMint && plan.quoteBefore !== undefined
        ? (await this.tokenBalance(new PublicKey(plan.quoteMint))) - BigInt(plan.quoteBefore)
        : budgetLamports;
      if (quoteAtoms <= 0n) throw new Error("Funding leg received no quote tokens");
      let instructions: TransactionInstruction[];
      if (plan.kind === "pump_nested") {
        if (!plan.path) throw new Error("Nested route path is absent from journal");
        const route: PumpNestedRoute = { venue: "pump_multihop", candidateMint: candidate.token,
          pool: candidate.pool, path: plan.path };
        instructions = (await this.pumpExecution.buildNestedBuyInstructions(route,
          this.signer.publicKey, quoteAtoms)).instructions;
      } else {
        instructions = await this.pumpExecution.buildBuyInstructions(candidate,
          this.signer.publicKey, quoteAtoms);
      }
      const latest = await this.sendConnection.getLatestBlockhash("confirmed");
      const message = new TransactionMessage({ payerKey: this.signer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ...instructions] })
        .compileToV0Message();
      const signature = await this.sendStep(job.candidateId, plan, plan.unsignedFunding.length,
        new VersionedTransaction(message));
      plan.finalSignature = signature;
      plan.pending = undefined;
      this.savePlan(job.candidateId, plan);
    }

    const lastFunding = plan.pending?.signature;
    const tx = plan.finalSignature ?? lastFunding;
    if (!tx) throw new Error("No confirmed purchase signature");
    const receivedAtoms = (await this.tokenBalance(new PublicKey(candidate.token))) - BigInt(plan.targetBefore);
    if (receivedAtoms <= 0n) throw new Error("Confirmed purchase yielded no target tokens");
    const rewardDecimals = await this.mintDecimals(new PublicKey(candidate.token));
    return { tx, receivedAtoms, rewardDecimals };
  }

  private async preparePlan(candidate: Candidate, budget: bigint): Promise<BuyPlan> {
    const targetBefore = (await this.tokenBalance(new PublicKey(candidate.token))).toString();
    const base = { candidateToken: candidate.token, budgetLamports: budget.toString(),
      targetBefore, fundingIndex: 0 };
    if (candidate.launchpad === "stonkfun") {
      const quote = await this.stonkQuotes.quote(candidate, budget);
      const transactions = await this.stonkQuotes.buildUnsignedTransactions(quote, this.signer.publicKey);
      return { ...base, kind: "stonk", unsignedFunding: transactions.map(serialize) };
    }
    let direct: Awaited<ReturnType<PumpPurchaseQuotes["quote"]>> | undefined;
    let nested: PumpNestedRoute | undefined;
    try { direct = await this.pumpQuotes.quote(candidate, budget, this.signer.publicKey); }
    catch (error) {
      if (!(error instanceof RaydiumRouteUnavailable)) throw error;
      nested = await this.pumpQuotes.planNestedRoute(candidate, budget);
    }
    const funding = direct?.funding ?? nested?.funding;
    const fundingMint = funding?.quoteMint;
    const quoteBefore = fundingMint ? (await this.tokenBalance(new PublicKey(fundingMint))).toString() : undefined;
    const transactions = funding
      ? await this.raydium.buildUnsignedTransactions(funding, this.signer.publicKey, 0n) : [];
    return { ...base, kind: nested ? "pump_nested" : "pump_direct", path: nested?.path,
      quoteMint: fundingMint, quoteBefore, unsignedFunding: transactions.map(serialize) };
  }

  private savePlan(candidateId: string, plan: BuyPlan): void {
    const job = this.store.getActiveJob();
    if (!job || job.candidateId !== candidateId || job.stage !== "snapshotted")
      throw new Error("Solana journal changed during purchase");
    this.store.advanceJob(candidateId, "snapshotted", "snapshotted", { ...job.data, buyPlan: plan });
  }

  private async sendStep(candidateId: string, plan: BuyPlan, index: number,
    unsigned: VersionedTransaction): Promise<string> {
    let pending = plan.pending;
    if (pending && pending.index !== index) throw new Error("Different Solana transaction is still pending");
    if (!pending) {
      const latest = await this.sendConnection.getLatestBlockhash("confirmed");
      unsigned.message.recentBlockhash = latest.blockhash;
      const message = Buffer.from(unsigned.message.serialize());
      const signed = await this.signer.sign(unsigned);
      if (!Buffer.from(signed.message.serialize()).equals(message) ||
          !signed.message.staticAccountKeys[0]?.equals(this.signer.publicKey) ||
          signed.signatures.length !== 1 ||
          !nacl.sign.detached.verify(message, signed.signatures[0]!, this.signer.publicKey.toBytes()))
        throw new Error("Signer changed the purchase transaction or returned an invalid signature");
      pending = { index, transaction: serialize(signed), signature: bs58.encode(signed.signatures[0]!),
        blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight };
      plan.pending = pending;
      this.savePlan(candidateId, plan);
    }
    const status = (await this.sendConnection.getSignatureStatuses([pending.signature],
      { searchTransactionHistory: true })).value[0];
    if (status?.err) throw new Error(`Purchase transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized")
      return pending.signature;
    if (await this.sendConnection.getBlockHeight("confirmed") > pending.lastValidBlockHeight)
      throw new Error("Signed purchase transaction expired; reconcile its signature before retrying");
    const transaction = VersionedTransaction.deserialize(Buffer.from(pending.transaction, "base64"));
    const simulation = await this.sendConnection.simulateTransaction(transaction,
      { sigVerify: true, commitment: "confirmed" });
    if (simulation.value.err) throw new Error(`Purchase simulation failed: ${JSON.stringify(simulation.value.err)}`);
    await this.sendConnection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 0 });
    const result = await this.sendConnection.confirmTransaction({ signature: pending.signature,
      blockhash: pending.blockhash, lastValidBlockHeight: pending.lastValidBlockHeight }, "confirmed");
    if (result.value.err) throw new Error(`Purchase transaction failed: ${JSON.stringify(result.value.err)}`);
    return pending.signature;
  }

  private async mintDecimals(mint: PublicKey): Promise<number> {
    const account = await this.sendConnection.getAccountInfo(mint, "confirmed");
    if (!account || (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID)))
      throw new Error("Reward token mint has an unsupported owner");
    return (await getMint(this.sendConnection, mint, "confirmed", account.owner)).decimals;
  }

  private async tokenBalance(mint: PublicKey): Promise<bigint> {
    const account = await this.sendConnection.getAccountInfo(mint, "confirmed");
    if (!account || (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID)))
      throw new Error("Purchase token mint has an unsupported owner");
    const ata = getAssociatedTokenAddressSync(mint, this.signer.publicKey, false, account.owner);
    if (!await this.sendConnection.getAccountInfo(ata, "confirmed")) return 0n;
    return (await getAccount(this.sendConnection, ata, "confirmed", account.owner)).amount;
  }
}

function serialize(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString("base64");
}
