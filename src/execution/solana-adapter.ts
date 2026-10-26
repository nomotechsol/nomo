import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { getAccount, getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { Allocation, Candidate } from "../domain.js";
import { finalizedHolderSnapshot } from "../solana/snapshot.js";
import { Store } from "../store.js";
import type { BuyReceipt, ExecutionAdapter, FundingReceipt, PublicationReceipt,
  SnapshotReceipt } from "./engine.js";
import { SolanaBuyExecutor, type SolanaTransactionSigner } from "./solana-buy.js";
import { RaydiumFundingQuotes } from "./solana-routes.js";
import { PURCHASE_SLIPPAGE_BPS } from "./slippage.js";
import { SolanaOperationSender } from "./solana-sender.js";

const require = createRequire(import.meta.url);
const { OnlinePumpSdk, PUMP_SDK, canonicalPumpPoolPdaWithQuote } =
  require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
const { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID } = require("@pump-fun/pump-swap-sdk") as typeof import("@pump-fun/pump-swap-sdk");
const PUMP = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
const NATIVE = new PublicKey("So11111111111111111111111111111111111111112");
/** Solana execution: creator fees → SOL → buy → backend reward wallet. */
export class SolanaExecutionAdapter implements ExecutionAdapter {
  private readonly sender: SolanaOperationSender;
  private readonly buyer: SolanaBuyExecutor;
  private readonly raydium: RaydiumFundingQuotes;
  private readonly sdk: InstanceType<typeof OnlinePumpSdk>;
  private readonly mainMint: PublicKey;

  constructor(private readonly store: Store, private readonly rpcUrl: string,
    private readonly connection: Connection, private readonly signer: SolanaTransactionSigner,
    private readonly rewardSigner: SolanaTransactionSigner, mainMint: string) {
    this.mainMint = new PublicKey(mainMint);
    if (signer.publicKey.equals(rewardSigner.publicKey))
      throw new Error("Treasury and reward wallets must be separate");
    this.sender = new SolanaOperationSender(store, connection, signer);
    this.buyer = new SolanaBuyExecutor(store, connection, connection, signer);
    this.raydium = new RaydiumFundingQuotes(connection);
    this.sdk = new OnlinePumpSdk(connection);
  }

  /** Refuse to start buying until the mint, treasury ownership and PUMP pool are real. */
  async assertReady(): Promise<void> {
    const [mintInfo, poolInfo, rewardSol] = await Promise.all([
      this.connection.getAccountInfo(this.mainMint, "finalized"),
      this.connection.getAccountInfo(this.mainPool(), "finalized"),
      this.connection.getBalance(this.rewardSigner.publicKey, "finalized"),
    ]);
    if (!mintInfo || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]
      .includes(mintInfo.owner.toBase58())) throw new Error("NOMO mint is not deployed");
    if (!poolInfo?.owner.equals(PUMP_AMM_PROGRAM_ID)) throw new Error("NOMO PUMP pool is not graduated");
    if (rewardSol < 10_000_000) throw new Error("Reward wallet needs at least 0.01 SOL for payout fees and rent");
    const pool = PUMP_AMM_SDK.decodePool(poolInfo);
    const curve = await this.sdk.fetchBondingCurve(this.mainMint);
    if (!pool.baseMint.equals(this.mainMint) || !pool.quoteMint.equals(PUMP) ||
        !pool.coinCreator.equals(this.signer.publicKey) ||
        !curve.creator.equals(this.signer.publicKey) || !curve.quoteMint.equals(PUMP))
      throw new Error("NOMO pool, quote or fee recipient does not match the execution wallet");
  }

  async collectCreatorFees(operationId: string): Promise<{ tx: string }> {
    const curve = await this.sdk.fetchBondingCurve(this.mainMint);
    if (!curve.creator.equals(this.signer.publicKey) || !curve.quoteMint.equals(PUMP))
      throw new Error("NOMO curve creator or quote mint differs from execution wallet");
    const poolKey = this.mainPool();
    const poolInfo = await this.connection.getAccountInfo(poolKey, "finalized");
    if (!poolInfo?.owner.equals(PUMP_AMM_PROGRAM_ID)) throw new Error("NOMO PumpSwap pool is not graduated");
    const pool = PUMP_AMM_SDK.decodePool(poolInfo);
    if (!pool.coinCreator.equals(this.signer.publicKey) || !pool.quoteMint.equals(PUMP))
      throw new Error("NOMO PumpSwap creator or quote mint differs from execution wallet");
    const sweepCurve = await PUMP_SDK.sweepCreatorFeeInstruction({ payer: this.signer.publicKey,
      mint: this.mainMint, creator: this.signer.publicKey, quoteMint: PUMP,
      quoteTokenProgram: TOKEN_PROGRAM_ID });
    const sweepPool = await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer: this.signer.publicKey,
      mint: this.mainMint, coinCreator: this.signer.publicKey, quoteMint: PUMP,
      quoteTokenProgram: TOKEN_PROGRAM_ID });
    await this.sender.execute(`${operationId}:sweep`, async () => this.transaction([sweepCurve, sweepPool], 700_000));
    const instructions = await this.sdk.collectCoinCreatorFeeAllQuotesInstructions(this.signer.publicKey,
      this.signer.publicKey, [PUMP]);
    if (instructions.length === 0) return { tx: "no-creator-fees" };
    // PUMP fees are the intended treasury source; other quote assets require explicit handling.
    const pumpInstructions = instructions.filter((ix) => ix.keys.some((key) => key.pubkey.equals(PUMP)));
    if (pumpInstructions.length === 0) return { tx: "no-pump-fees" };
    const tx = await this.sender.execute(`${operationId}:collect`, async () => this.transaction(pumpInstructions, 700_000));
    return { tx };
  }

  async convertPumpToSol(operationId: string): Promise<{ tx: string }> {
    const ata = getAssociatedTokenAddressSync(PUMP, this.signer.publicKey);
    const info = await this.connection.getAccountInfo(ata, "confirmed");
    if (!info) return { tx: "no-pump-balance" };
    const amount = (await getAccount(this.connection, ata, "confirmed")).amount;
    if (amount === 0n) return { tx: "no-pump-balance" };
    const quote = await this.raydium.quotePair(PUMP, NATIVE, amount, PURCHASE_SLIPPAGE_BPS);
    const transactions = await this.raydium.buildUnsignedTransactions(quote, this.signer.publicKey, 0n);
    let tx = "";
    for (let i = 0; i < transactions.length; i++) {
      const unsigned = transactions[i]!;
      tx = await this.sender.execute(`${operationId}:${i}`, async () => unsigned);
    }
    return { tx };
  }

  availableSolLamports(): Promise<bigint> { return this.buyer.availableSolLamports(); }

  async bridge(): Promise<{ tx: string; receivedAtoms: bigint }> {
    throw new Error("Solana adapter cannot bridge EVM purchases");
  }

  async snapshot(): Promise<SnapshotReceipt> {
    const result = await finalizedHolderSnapshot({ rpcUrl: this.rpcUrl, mainMint: this.mainMint.toBase58() });
    return { slot: result.slot, holders: result.holders };
  }

  buy(operationId: string, candidate: Candidate, spendAtoms: bigint): Promise<BuyReceipt> {
    return this.buyer.buy(operationId, candidate, spendAtoms);
  }

  async fund(operationId: string, candidate: Candidate, purchase: BuyReceipt,
    holderAtoms: bigint, ownerAtoms: bigint): Promise<FundingReceipt> {
    if (candidate.chain !== "sol" || holderAtoms <= 0n || holderAtoms + ownerAtoms !== purchase.receivedAtoms)
      throw new Error("Invalid Solana reward split");
    const job = this.store.getActiveJob();
    if (!job || job.stage !== "purchased" || operationId !== `${job.candidateId}:fund`)
      throw new Error("Reward funding does not match purchase journal");
    const snapshotSlot = job.data.snapshotSlot;
    if (!Number.isSafeInteger(snapshotSlot) || Number(snapshotSlot) <= 0) throw new Error("Missing snapshot slot");
    const mint = new PublicKey(candidate.token);
    const mintInfo = await this.connection.getAccountInfo(mint, "confirmed");
    if (!mintInfo || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]
      .includes(mintInfo.owner.toBase58())) throw new Error("Unsupported reward token program");
    const tokenProgram = mintInfo.owner;
    const decimals = (await getMint(this.connection, mint, "confirmed", tokenProgram)).decimals;
    const vault = getAssociatedTokenAddressSync(mint, this.rewardSigner.publicKey, false, tokenProgram);
    const fundingAccount = getAssociatedTokenAddressSync(mint, this.signer.publicKey, false, tokenProgram);
    const instructions = [createAssociatedTokenAccountIdempotentInstruction(this.signer.publicKey,
      vault, this.rewardSigner.publicKey, mint, tokenProgram),
    createTransferCheckedInstruction(fundingAccount, mint, vault, this.signer.publicKey,
      holderAtoms, decimals, [], tokenProgram)];
    const tx = await this.sender.execute(operationId, async () => this.transaction(instructions, 350_000));
    const receipt = await this.connection.getParsedTransaction(tx, { commitment: "confirmed",
      maxSupportedTransactionVersion: 0 });
    if (!receipt?.meta || receipt.meta.err) throw new Error("Reward transfer receipt is unavailable");
    const tokenDelta = (receipt.meta.postTokenBalances ?? []).find((balance) => balance.mint === candidate.token &&
      balance.owner === this.rewardSigner.publicKey.toBase58());
    const before = (receipt.meta.preTokenBalances ?? []).find((balance) => balance.accountIndex === tokenDelta?.accountIndex);
    const creditedAtoms = BigInt(tokenDelta?.uiTokenAmount.amount ?? "0") -
      BigInt(before?.uiTokenAmount.amount ?? "0");
    if (creditedAtoms <= 0n || creditedAtoms > holderAtoms) throw new Error("Invalid credited reward amount");
    return { tx, creditedAtoms, ownerRetainedAtoms: ownerAtoms };
  }

  async publish(operationId: string, candidate: Candidate, roundId: bigint,
    allocations: Allocation[], fundedAtoms: bigint): Promise<PublicationReceipt> {
    if (candidate.chain !== "sol") throw new Error("Solana adapter cannot publish an EVM round");
    const digest = createHash("sha256").update(JSON.stringify({ roundId: roundId.toString(),
      allocations: allocations.map((item) => ({ solWallet: item.solWallet,
        rewardAtoms: item.rewardAtoms.toString() })), fundedAtoms: fundedAtoms.toString() })).digest("hex");
    return { tx: `backend:${operationId}`, root: `0x${digest}`,
      claimTarget: this.rewardSigner.publicKey.toBase58() };
  }

  private mainPool(): PublicKey {
    return canonicalPumpPoolPdaWithQuote(this.mainMint, PUMP);
  }

  private async transaction(instructions: TransactionInstruction[], units: number): Promise<VersionedTransaction> {
    const latest = await this.connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({ payerKey: this.signer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...instructions] }).compileToV0Message();
    return new VersionedTransaction(message);
  }
}
