import "dotenv/config";
import { ComputeBudgetProgram, Connection, Keypair, TransactionMessage, VersionedTransaction,
  PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PumpPurchaseQuotes, RaydiumFundingQuotes, RaydiumRouteUnavailable } from "../src/execution/solana-routes.js";
import { Store } from "../src/store.js";

let smokeStage = "initialization";
try {
const localUrl = process.env.LOCAL_SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
if (!process.env.HELIUS_RPC_URL) throw new Error("HELIUS_RPC_URL is required for a mainnet fork");
const local = new Connection(localUrl, "confirmed");
const mainnet = new Connection(process.env.HELIUS_RPC_URL, "finalized");
const token = process.argv[2] ?? "2zoMuW8x7qm7qQAh8zzqfib292KqDQn9mFtg1hiSpump";
const store = new Store(process.env.DATABASE_PATH ?? "./data/nomo.db");
const candidate = store.listCandidates(10_000).find((row) => row.candidate.token === token)?.candidate;
if (!candidate || candidate.chain !== "sol" || candidate.launchpad !== "pumpfun" || !candidate.quoteMint)
  throw new Error("A verified Pump.fun candidate with a quote mint is required");

const user = Keypair.generate(); // Ephemeral local-only test wallet. Never written to disk.
smokeStage = "local airdrop";
const airdrop = await local.requestAirdrop(user.publicKey, 2_000_000_000);
await local.confirmTransaction(airdrop, "confirmed");
const raydium = new RaydiumFundingQuotes(mainnet);
const pump = new PumpPurchaseQuotes(mainnet, raydium);
smokeStage = "route quotes";
let direct: Awaited<ReturnType<typeof pump.quote>> | undefined;
let nested: Awaited<ReturnType<typeof pump.planNestedRoute>> | undefined;
try { direct = await pump.quote(candidate, 10_000_000n, user.publicKey); }
catch (error) {
  if (!(error instanceof RaydiumRouteUnavailable)) throw error;
  nested = await pump.planNestedRoute(candidate, 10_000_000n);
}
const fundingQuote = direct?.funding ?? nested?.funding;
const funding = fundingQuote ? await raydium.buildUnsignedTransactions(fundingQuote, user.publicKey, 0n) : [];
for (const transaction of funding) {
  smokeStage = "Raydium local simulation";
  transaction.message.recentBlockhash = (await local.getLatestBlockhash("confirmed")).blockhash;
  transaction.sign([user]);
  const simulation = await local.simulateTransaction(transaction, { sigVerify: true, commitment: "confirmed" });
  smokeStage = "Raydium local simulation result";
  if (simulation.value.err) {
    process.stderr.write(`Local Raydium program result: ${JSON.stringify(simulation.value.err)}\n`);
    process.stderr.write(`Local Raydium logs: ${JSON.stringify(simulation.value.logs?.slice(-18) ?? [])}\n`);
    throw new Error("Local Raydium simulation failed");
  }
  smokeStage = "Raydium local submission";
  const signature = await local.sendTransaction(transaction, { skipPreflight: true });
  smokeStage = "Raydium local confirmation";
  const receipt = await local.confirmTransaction(signature, "confirmed");
  if (receipt.value.err) throw new Error(`Local Raydium swap failed: ${JSON.stringify(receipt.value.err)}`);
}

const quoteMint = new PublicKey(direct?.quoteMint ?? nested!.path[0]!);
let acquiredQuoteAtoms = 10_000_000n;
if (fundingQuote) {
  const quoteInfo = await local.getAccountInfo(quoteMint, "confirmed");
  if (!quoteInfo || (!quoteInfo.owner.equals(TOKEN_PROGRAM_ID) && !quoteInfo.owner.equals(TOKEN_2022_PROGRAM_ID)))
    throw new Error("Quote mint owner is invalid on the local fork");
  const quoteAccount = getAssociatedTokenAddressSync(quoteMint, user.publicKey, false, quoteInfo.owner);
  acquiredQuoteAtoms = (await getAccount(local, quoteAccount, "confirmed", quoteInfo.owner)).amount;
  if (acquiredQuoteAtoms <= 0n) throw new Error("Local Raydium leg received no quote tokens");
}

const localPump = new PumpPurchaseQuotes(local, raydium);
smokeStage = "PumpSwap instruction build";
const instructions = nested
  ? (await localPump.buildNestedBuyInstructions(nested, user.publicKey, acquiredQuoteAtoms)).instructions
  : await localPump.buildBuyInstructions(candidate, user.publicKey, acquiredQuoteAtoms);
// Eagerly clone explicit accounts before Surfpool's transaction verification.
smokeStage = "PumpSwap local account preload";
const neededAccounts = [...new Map(instructions.flatMap((instruction) => instruction.keys)
  .map((account) => [account.pubkey.toBase58(), account.pubkey])).values()];
for (let index = 0; index < neededAccounts.length; index += 100)
  await local.getMultipleAccountsInfo(neededAccounts.slice(index, index + 100), "confirmed");
const latest = await local.getLatestBlockhash("confirmed");
const message = new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: latest.blockhash,
  instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...instructions] }).compileToV0Message();
const purchase = new VersionedTransaction(message);
purchase.sign([user]);
smokeStage = "PumpSwap local simulation";
const simulation = await local.simulateTransaction(purchase, { sigVerify: true, commitment: "confirmed" });
smokeStage = "PumpSwap local simulation result";
if (simulation.value.err) {
  process.stderr.write(`Local PumpSwap program result: ${JSON.stringify(simulation.value.err)}\n`);
  process.stderr.write(`Local PumpSwap logs: ${JSON.stringify(simulation.value.logs?.slice(-18) ?? [])}\n`);
  throw new Error("Local PumpSwap simulation failed");
}
// The transaction was just simulated; Surfpool may fail a second preflight when its remote datasource is busy.
smokeStage = "PumpSwap local submission";
const purchaseSignature = await local.sendTransaction(purchase, { skipPreflight: true });
smokeStage = "PumpSwap local confirmation";
const receipt = await local.confirmTransaction(purchaseSignature, "confirmed");
if (receipt.value.err) throw new Error(`Local PumpSwap purchase failed: ${JSON.stringify(receipt.value.err)}`);
const baseMint = new PublicKey(candidate.token);
const baseInfo = await local.getAccountInfo(baseMint, "confirmed");
if (!baseInfo) throw new Error("Purchased mint missing on local fork");
const baseAccount = getAssociatedTokenAddressSync(baseMint, user.publicKey, false, baseInfo.owner);
const purchasedAtoms = (await getAccount(local, baseAccount, "confirmed", baseInfo.owner)).amount;
if (purchasedAtoms <= 0n) throw new Error("Local PumpSwap purchase received no target tokens");
process.stdout.write(JSON.stringify({ cluster: "local Surfpool fork", target: candidate.token,
  quoteMint: quoteMint.toBase58(), routePath: nested?.path,
  quoteReceivedAtoms: acquiredQuoteAtoms.toString(),
  purchasedAtoms: purchasedAtoms.toString(), fundingTransactions: funding.length,
  purchaseSignature }) + "\n");
store.close();
} catch (error) {
  // RPC errors can contain the full provider URL, including its key. Never print raw errors here.
  const detail = error instanceof Error ? error.message
    .replace(/https?:\/\/[^\s"']+/g, "[rpc]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[id]").slice(0, 400) : "unknown error";
  process.stderr.write(`Local route smoke failed at ${smokeStage}: ${detail}\n`);
  process.exitCode = 1;
}
