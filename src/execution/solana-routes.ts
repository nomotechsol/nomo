import { createRequire } from "node:module";
import BN from "bn.js";
import { getAccount, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction,
  type TransactionInstruction } from "@solana/web3.js";
import { type Candidate } from "../domain.js";
import { PURCHASE_SLIPPAGE_BPS, validPurchaseSlippage } from "./slippage.js";

const require = createRequire(import.meta.url);
const { PUMP_AMM_PROGRAM_ID, PUMP_AMM_SDK, OnlinePumpAmmSdk, buyQuoteInput } =
  require("@pump-fun/pump-swap-sdk") as typeof import("@pump-fun/pump-swap-sdk");
const { OnlinePumpSdk, PUMP_SDK, canonicalPumpPoolPdaWithQuote, normalizeQuoteMint } =
  require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");

const RAYDIUM_PROGRAMS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // AMM v4
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // CPMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // CLMM
]);
// Raydium's priceImpactPct is in percent. Do not silently impose a 5% cap on
// purchases whose explicitly selected slippage limit is 99%.
const MAX_PRICE_IMPACT = 99;
const RAYDIUM_TRANSACTION_PROGRAMS = new Set([...RAYDIUM_PROGRAMS,
  "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

type FundingLeg = { poolId: string; inputMint: string; outputMint: string };
type RaydiumResponse = { success?: boolean; data?: {
  swapType?: string; inputMint?: string; outputMint?: string; inputAmount?: string; outputAmount?: string;
  otherAmountThreshold?: string; slippageBps?: number; priceImpactPct?: number;
  routePlan?: FundingLeg[];
} };

export type SolanaFundingQuote = {
  venue: "raydium";
  inputMint: string;
  inputLamports: bigint;
  expectedQuoteAtoms: bigint;
  minimumQuoteAtoms: bigint;
  quoteMint: string;
  pools: string[];
  quotedAt: number;
  /** Exact server response is bound to a short-lived quote and must be rechecked before building a transaction. */
  swapResponse: RaydiumResponse;
};

export type PumpPurchaseQuote = {
  venue: "pumpswap";
  candidateMint: string;
  pool: string;
  quoteMint: string;
  solBudgetLamports: bigint;
  spendableQuoteAtoms: bigint;
  expectedBaseAtoms: bigint;
  minimumBaseAtoms: bigint;
  funding?: SolanaFundingQuote;
};

export type PumpNestedRoute = {
  venue: "pump_multihop";
  candidateMint: string;
  pool: string;
  /** Mints from the funded input asset through each Pump hop to the target token. */
  path: string[];
  funding?: SolanaFundingQuote;
};

export class RaydiumRouteUnavailable extends Error {}

function positiveAtoms(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new Error("Invalid route amount");
  return BigInt(value);
}

/** Raydium-only SOL funding; validates every quoted pool against on-chain program ownership. */
export class RaydiumFundingQuotes {
  constructor(private readonly connection: Connection, private readonly request: typeof fetch = fetch) {}

  async quote(outputMint: PublicKey, inputLamports: bigint, slippageBps: number): Promise<SolanaFundingQuote> {
    return this.quotePair(NATIVE_MINT, outputMint, inputLamports, slippageBps);
  }

  /** Also supports creator-fee conversion PUMP → SOL without Jupiter. */
  async quotePair(inputMint: PublicKey, outputMint: PublicKey, inputLamports: bigint,
    slippageBps: number): Promise<SolanaFundingQuote> {
    if (inputLamports <= 0n || !validPurchaseSlippage(slippageBps))
      throw new Error("Invalid funding budget or slippage");
    if (inputMint.equals(outputMint)) throw new Error("Input and output mints are identical");
    const params = new URLSearchParams({ inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(),
      amount: inputLamports.toString(), slippageBps: String(slippageBps), txVersion: "V0" });
    const response = await this.request(`https://transaction-v1.raydium.io/compute/swap-base-in?${params}`,
      { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Raydium quote HTTP ${response.status}`);
    const envelope = await response.json() as RaydiumResponse;
    const data = envelope.data;
    if (!envelope.success) throw new RaydiumRouteUnavailable("Raydium has no route to this quote asset");
    if (!data || data.swapType !== "BaseIn" ||
        data.inputMint !== inputMint.toBase58() || data.outputMint !== outputMint.toBase58() ||
        data.inputAmount !== inputLamports.toString() || data.slippageBps !== slippageBps ||
        !Array.isArray(data.routePlan) || data.routePlan.length < 1 || data.routePlan.length > 4 ||
        typeof data.priceImpactPct !== "number" || !Number.isFinite(data.priceImpactPct) ||
        data.priceImpactPct < 0 || data.priceImpactPct > MAX_PRICE_IMPACT)
      throw new Error("Raydium quote does not match the requested route or exceeds the price-impact cap");
    const expectedQuoteAtoms = positiveAtoms(data.outputAmount);
    const minimumQuoteAtoms = positiveAtoms(data.otherAmountThreshold);
    if (minimumQuoteAtoms > expectedQuoteAtoms) throw new Error("Raydium minimum output exceeds the quote");
    let previousMint = inputMint.toBase58();
    const pools: string[] = [];
    for (const leg of data.routePlan) {
      if (!leg || leg.inputMint !== previousMint || typeof leg.poolId !== "string" ||
          typeof leg.outputMint !== "string" || leg.inputMint === leg.outputMint)
        throw new Error("Raydium route is discontinuous");
      pools.push(new PublicKey(leg.poolId).toBase58());
      previousMint = new PublicKey(leg.outputMint).toBase58();
    }
    if (previousMint !== outputMint.toBase58() || new Set(pools).size !== pools.length)
      throw new Error("Raydium route does not end at the quote mint");
    const infos = await this.connection.getMultipleAccountsInfo(pools.map((pool) => new PublicKey(pool)), "finalized");
    if (infos.length !== pools.length || infos.some((info) => !info || !RAYDIUM_PROGRAMS.has(info.owner.toBase58())))
      throw new Error("Raydium route contains an unverified pool");
    return { venue: "raydium", inputMint: inputMint.toBase58(), inputLamports, expectedQuoteAtoms, minimumQuoteAtoms,
      quoteMint: outputMint.toBase58(), pools, quotedAt: Date.now(), swapResponse: envelope };
  }

  /** Builds only; the caller must simulate, sign and reconcile each returned transaction. */
  async buildUnsignedTransactions(quote: SolanaFundingQuote, user: PublicKey,
    computeUnitPriceMicroLamports: bigint): Promise<VersionedTransaction[]> {
    if (Date.now() - quote.quotedAt > 25_000 || quote.quotedAt > Date.now() ||
        computeUnitPriceMicroLamports < 0n || computeUnitPriceMicroLamports > 1_000_000n)
      throw new Error("Raydium quote expired or compute-unit price is invalid");
    let inputAccount: string | undefined;
    if (quote.inputMint !== NATIVE_MINT.toBase58()) {
      const mint = new PublicKey(quote.inputMint);
      const mintInfo = await this.connection.getAccountInfo(mint, "confirmed");
      if (!mintInfo || (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) &&
          !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)))
        throw new Error("Raydium input mint has an invalid token program");
      const ata = getAssociatedTokenAddressSync(mint, user, false, mintInfo.owner);
      const account = await getAccount(this.connection, ata, "confirmed", mintInfo.owner);
      if (!account.owner.equals(user) || !account.mint.equals(mint) || account.amount < quote.inputLamports)
        throw new Error("Raydium input token account has insufficient balance");
      inputAccount = ata.toBase58();
    }
    const response = await this.request("https://transaction-v1.raydium.io/transaction/swap-base-in", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ computeUnitPriceMicroLamports: computeUnitPriceMicroLamports.toString(),
        swapResponse: quote.swapResponse, txVersion: "V0", wallet: user.toBase58(),
        wrapSol: quote.inputMint === NATIVE_MINT.toBase58(),
        unwrapSol: quote.quoteMint === NATIVE_MINT.toBase58(), inputAccount }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Raydium transaction builder HTTP ${response.status}`);
    const result = await response.json() as { success?: boolean; msg?: string;
      data?: Array<{ transaction?: string }> };
    if (!result.success || !Array.isArray(result.data) || result.data.length < 1 || result.data.length > 4)
      throw new Error(`Raydium transaction builder returned no usable transactions: ${result.msg ?? "unknown error"}`);
    const transactions: VersionedTransaction[] = [];
    const allAccounts = new Set<string>();
    let hasRaydiumSwap = false;
    for (const row of result.data) {
      if (typeof row.transaction !== "string") throw new Error("Raydium transaction is missing");
      const transaction = VersionedTransaction.deserialize(Buffer.from(row.transaction, "base64"));
      if (transaction.message.version !== 0 ||
          !transaction.message.staticAccountKeys[0]?.equals(user) ||
          transaction.message.header.numRequiredSignatures !== 1)
        throw new Error("Raydium transaction payer, version or signer count changed");
      const tables = await Promise.all(transaction.message.addressTableLookups.map(async (lookup) => {
        const result = await this.connection.getAddressLookupTable(lookup.accountKey);
        if (!result.value) throw new Error("Raydium address lookup table is missing");
        return result.value;
      }));
      const message = TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts: tables });
      for (const instruction of message.instructions) {
        const program = instruction.programId.toBase58();
        if (!RAYDIUM_TRANSACTION_PROGRAMS.has(program))
          throw new Error(`Raydium transaction contains an unapproved program: ${program}`);
        if (RAYDIUM_PROGRAMS.has(program) || program === "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS")
          hasRaydiumSwap = true;
        for (const account of instruction.keys) {
          if (account.isSigner && !account.pubkey.equals(user))
            throw new Error("Raydium transaction requires an unexpected signer");
          allAccounts.add(account.pubkey.toBase58());
        }
      }
      transactions.push(transaction);
    }
    if (!hasRaydiumSwap || quote.pools.some((pool) => !allAccounts.has(pool)) ||
        !allAccounts.has(quote.quoteMint) || (inputAccount && !allAccounts.has(inputAccount)))
      throw new Error("Raydium transaction differs from the verified quote route");
    return transactions;
  }
}

/** Builds a post-graduation StonkFun buy via Raydium without assuming a SOL quote pair. */
export class StonkPurchaseQuotes {
  private readonly raydium: RaydiumFundingQuotes;

  constructor(private readonly connection: Connection, request: typeof fetch = fetch) {
    this.raydium = new RaydiumFundingQuotes(connection, request);
  }

  async quote(candidate: Candidate, solBudgetLamports: bigint,
    slippageBps = PURCHASE_SLIPPAGE_BPS): Promise<SolanaFundingQuote> {
    if (candidate.chain !== "sol" || candidate.launchpad !== "stonkfun" || !candidate.pool ||
        !candidate.quoteMint || !candidate.graduationTx)
      throw new Error("StonkFun purchase needs a verified migration and quote mint");
    const origin = await this.connection.getAccountInfo(new PublicKey(candidate.pool), "finalized");
    if (!origin?.owner.equals(new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj")))
      throw new Error("StonkFun LaunchLab origin pool is invalid");
    return this.raydium.quote(new PublicKey(candidate.token), solBudgetLamports, slippageBps);
  }

  async buildUnsignedTransactions(quote: SolanaFundingQuote, user: PublicKey,
    computeUnitPriceMicroLamports = 0n): Promise<VersionedTransaction[]> {
    return this.raydium.buildUnsignedTransactions(quote, user, computeUnitPriceMicroLamports);
  }
}

/** Read-only quote for a verified, graduated PumpSwap pool; sending is a separate adapter. */
export class PumpPurchaseQuotes {
  private readonly sdk: InstanceType<typeof OnlinePumpAmmSdk>;
  private readonly pumpSdk: InstanceType<typeof OnlinePumpSdk>;

  constructor(private readonly connection: Connection, private readonly raydium = new RaydiumFundingQuotes(connection)) {
    this.sdk = new OnlinePumpAmmSdk(connection);
    this.pumpSdk = new OnlinePumpSdk(connection);
  }

  async quote(candidate: Candidate, solBudgetLamports: bigint, user: PublicKey,
    slippageBps = PURCHASE_SLIPPAGE_BPS): Promise<PumpPurchaseQuote> {
    if (candidate.chain !== "sol" || candidate.launchpad !== "pumpfun" || !candidate.pool || !candidate.quoteMint ||
        candidate.isMayhemMode !== false || solBudgetLamports <= 0n ||
        !validPurchaseSlippage(slippageBps))
      throw new Error("Pump purchase is missing a verified pool, quote mint, or budget");
    const poolKey = new PublicKey(candidate.pool);
    const account = await this.connection.getAccountInfo(poolKey, "finalized");
    if (!account?.owner.equals(PUMP_AMM_PROGRAM_ID)) throw new Error("Pump pool owner is invalid");
    const pool = PUMP_AMM_SDK.decodePool(account);
    if (!pool.baseMint.equals(new PublicKey(candidate.token)) ||
        !pool.quoteMint.equals(new PublicKey(candidate.quoteMint)) || pool.isMayhemMode)
      throw new Error("Pump pool identity changed or is Mayhem Mode");
    const funding = pool.quoteMint.equals(NATIVE_MINT) ? undefined :
      await this.raydium.quote(pool.quoteMint, solBudgetLamports, slippageBps);
    // Planning estimate only. After funding settles, quote again using the actual received balance.
    const spendableQuoteAtoms = funding?.expectedQuoteAtoms ?? solBudgetLamports;
    const state = await this.sdk.swapSolanaState(poolKey, user);
    if (!state.pool.baseMint.equals(pool.baseMint) || !state.pool.quoteMint.equals(pool.quoteMint) ||
        state.pool.isMayhemMode) throw new Error("Pump quote state differs from verified pool");
    const quoted = buyQuoteInput({ quote: new BN(spendableQuoteAtoms.toString()),
      slippage: slippageBps / 100, baseReserve: state.poolBaseAmount, quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: state.pool.virtualQuoteReserves, globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount, baseMint: state.baseMint,
      coinCreator: state.pool.coinCreator, creator: state.pool.creator, feeConfig: state.feeConfig,
      quoteMint: state.pool.quoteMint, isMayhemMode: state.pool.isMayhemMode,
      creatorFeeBps: state.pool.creatorFeeBps, quoteTransferFee: state.quoteTransferFee, tradeV2: true });
    const expectedBaseAtoms = BigInt(quoted.base.toString());
    const minimumBaseAtoms = expectedBaseAtoms * BigInt(10_000 - slippageBps) / 10_000n;
    if (minimumBaseAtoms <= 0n) throw new Error("Pump quote produces no spendable output");
    return { venue: "pumpswap", candidateMint: candidate.token, pool: candidate.pool,
      quoteMint: pool.quoteMint.toBase58(), solBudgetLamports, spendableQuoteAtoms,
      expectedBaseAtoms, minimumBaseAtoms, funding };
  }

  /** Rechecks the pool and prices the actual post-funding balance immediately before building. */
  async buildBuyInstructions(candidate: Candidate, user: PublicKey, spendableQuoteAtoms: bigint,
    slippageBps = PURCHASE_SLIPPAGE_BPS): Promise<TransactionInstruction[]> {
    if (candidate.chain !== "sol" || candidate.launchpad !== "pumpfun" || !candidate.pool || !candidate.quoteMint ||
        candidate.isMayhemMode !== false || spendableQuoteAtoms <= 0n || !validPurchaseSlippage(slippageBps))
      throw new Error("Pump purchase is missing verified inputs");
    const poolKey = new PublicKey(candidate.pool);
    const account = await this.connection.getAccountInfo(poolKey, "finalized");
    if (!account?.owner.equals(PUMP_AMM_PROGRAM_ID)) throw new Error("Pump pool owner is invalid");
    const pool = PUMP_AMM_SDK.decodePool(account);
    if (!pool.baseMint.equals(new PublicKey(candidate.token)) ||
        !pool.quoteMint.equals(new PublicKey(candidate.quoteMint)) || pool.isMayhemMode)
      throw new Error("Pump pool identity changed or is Mayhem Mode");
    const state = await this.sdk.swapSolanaState(poolKey, user);
    if (!state.pool.baseMint.equals(pool.baseMint) || !state.pool.quoteMint.equals(pool.quoteMint) ||
        state.pool.isMayhemMode) throw new Error("Pump quote state differs from verified pool");
    const quoted = buyQuoteInput({ quote: new BN(spendableQuoteAtoms.toString()),
      slippage: slippageBps / 100, baseReserve: state.poolBaseAmount, quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: state.pool.virtualQuoteReserves, globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount, baseMint: state.baseMint,
      coinCreator: state.pool.coinCreator, creator: state.pool.creator, feeConfig: state.feeConfig,
      quoteMint: state.pool.quoteMint, isMayhemMode: state.pool.isMayhemMode,
      creatorFeeBps: state.pool.creatorFeeBps, quoteTransferFee: state.quoteTransferFee, tradeV2: true });
    const minimumBaseAtoms = BigInt(quoted.base.toString()) * BigInt(10_000 - slippageBps) / 10_000n;
    if (minimumBaseAtoms <= 0n) throw new Error("Pump quote produces no spendable output");
    const instructions = await PUMP_AMM_SDK.buyExactQuoteInV2Instructions(state,
      new BN(spendableQuoteAtoms.toString()), new BN(minimumBaseAtoms.toString()));
    if (!instructions.some((instruction) => instruction.programId.equals(PUMP_AMM_PROGRAM_ID)))
      throw new Error("PumpSwap buy instruction is missing");
    return instructions;
  }

  /** Finds a Raydium-funded ancestor when the immediate quote coin has no SOL route. */
  async planNestedRoute(candidate: Candidate, solBudgetLamports: bigint,
    slippageBps = PURCHASE_SLIPPAGE_BPS): Promise<PumpNestedRoute> {
    if (candidate.chain !== "sol" || candidate.launchpad !== "pumpfun" || !candidate.pool || !candidate.quoteMint ||
        candidate.isMayhemMode !== false || solBudgetLamports <= 0n || !validPurchaseSlippage(slippageBps))
      throw new Error("Pump candidate is missing verified route data");
    const baseMint = new PublicKey(candidate.token);
    const quoteMint = new PublicKey(candidate.quoteMint);
    if (!canonicalPumpPoolPdaWithQuote(baseMint, quoteMint).equals(new PublicKey(candidate.pool)))
      throw new Error("Pump candidate pool is not canonical");
    const poolInfo = await this.connection.getAccountInfo(new PublicKey(candidate.pool), "finalized");
    if (!poolInfo?.owner.equals(PUMP_AMM_PROGRAM_ID)) throw new Error("Pump candidate pool owner is invalid");
    const pool = PUMP_AMM_SDK.decodePool(poolInfo);
    if (!pool.baseMint.equals(baseMint) || !pool.quoteMint.equals(quoteMint) || pool.isMayhemMode)
      throw new Error("Pump candidate pool identity changed or is Mayhem Mode");
    const path = [candidate.token];
    const seen = new Set(path);
    let current = quoteMint;
    let funding: SolanaFundingQuote | undefined;
    for (let depth = 0; depth < 4; depth++) {
      if (seen.has(current.toBase58())) throw new Error("Pump quote chain contains a cycle");
      seen.add(current.toBase58());
      path.unshift(current.toBase58());
      if (current.equals(NATIVE_MINT)) break;
      try {
        funding = await this.raydium.quote(current, solBudgetLamports, slippageBps);
        break;
      } catch (error) {
        if (!(error instanceof RaydiumRouteUnavailable)) throw error;
      }
      const curve = await this.pumpSdk.fetchBondingCurve(current);
      // Legacy SOL curves store the zero key, whereas PumpSwap multi-hop paths
      // use WSOL. Without normalization we try to fetch a curve for the zero key.
      current = normalizeQuoteMint(curve.quoteMint);
      if (depth === 3) throw new Error("Pump quote chain is deeper than the supported route");
    }
    const hops = await this.pumpSdk.resolveMultiHopRoute(path.map((mint) => new PublicKey(mint)), "buy");
    if (hops.length !== path.length - 1 || hops.length < 1 || hops.length > 3 ||
        !hops.at(-1)?.baseMint.equals(baseMint) || !hops.at(-1)?.quoteMint.equals(quoteMint) ||
        hops.at(-1)?.venue !== "pool")
      throw new Error("Pump quote chain does not end at the verified migrated pool");
    return { venue: "pump_multihop", candidateMint: candidate.token, pool: candidate.pool, path, funding };
  }

  /** Call after the first funding leg settles; it simulates the actual holder's input balance. */
  async buildNestedBuyInstructions(route: PumpNestedRoute, user: PublicKey, amountIn: bigint,
    slippageBps = PURCHASE_SLIPPAGE_BPS): Promise<{ instructions: TransactionInstruction[]; minimumBaseAtoms: bigint }> {
    if (amountIn <= 0n || !validPurchaseSlippage(slippageBps) ||
        route.path.length < 2 || route.path.length > 4 || route.path.at(-1) !== route.candidateMint)
      throw new Error("Invalid Pump multi-hop execution inputs");
    const hops = await this.pumpSdk.resolveMultiHopRoute(route.path.map((mint) => new PublicKey(mint)), "buy");
    const expected = await this.pumpSdk.simulateMultiHopSwap({ user, hops, side: "buy", amountIn: new BN(amountIn.toString()) });
    const minimumBaseAtoms = BigInt(expected.toString()) * BigInt(10_000 - slippageBps) / 10_000n;
    if (minimumBaseAtoms <= 0n) throw new Error("Pump multi-hop simulation yields no target tokens");
    const instructions = await PUMP_SDK.multiHopSwapInstructions({ user, hops, side: "buy",
      amountIn: new BN(amountIn.toString()), minAmountOut: new BN(minimumBaseAtoms.toString()) });
    return { instructions, minimumBaseAtoms };
  }
}
