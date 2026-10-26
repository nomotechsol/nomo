import "dotenv/config";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage,
  VersionedTransaction } from "@solana/web3.js";
import { PumpPurchaseQuotes, RaydiumFundingQuotes, RaydiumRouteUnavailable } from
  "../src/execution/solana-routes.js";
import { Store } from "../src/store.js";

const token = process.argv[2];
if (!token || !process.env.HELIUS_RPC_URL) throw new Error("Token and HELIUS_RPC_URL required");
const store = new Store(process.env.DATABASE_PATH ?? "./data/nomo.db");
const candidate = store.listCandidates(10_000).find((row) => row.candidate.token === token)?.candidate;
store.close();
if (!candidate || candidate.chain !== "sol" || candidate.launchpad !== "pumpfun" || !candidate.quoteMint)
  throw new Error("Verified Pump.fun candidate required");
const localUrl = process.env.LOCAL_SOLANA_RPC_URL ?? "http://127.0.0.1:8999";
const local = new Connection(localUrl, "confirmed");
const mainnet = new Connection(process.env.HELIUS_RPC_URL, "finalized");
const wallet = Keypair.generate();
let stage = "setup";
try {
  const airdrop = await local.requestAirdrop(wallet.publicKey, 2_000_000_000);
  await local.confirmTransaction(airdrop, "confirmed");
  const pump = new PumpPurchaseQuotes(mainnet, new RaydiumFundingQuotes(mainnet));
  let direct: Awaited<ReturnType<typeof pump.quote>> | undefined;
  let nested: Awaited<ReturnType<typeof pump.planNestedRoute>> | undefined;
  stage = "route";
  try { direct = await pump.quote(candidate, 10_000_000n, wallet.publicKey); }
  catch (error) {
    if (!(error instanceof RaydiumRouteUnavailable)) throw error;
    nested = await pump.planNestedRoute(candidate, 10_000_000n);
  }
  const startMint = direct?.quoteMint ?? nested?.path[0];
  if (!startMint) throw new Error("No input mint for purchase");
  const fundedAtoms = direct?.funding?.expectedQuoteAtoms ?? nested?.funding?.expectedQuoteAtoms ?? 10_000_000n;
  if (fundedAtoms > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Quote amount exceeds safe local fixture range");
  stage = "local quote account";
  const quoteMintInfo = await local.getAccountInfo(new PublicKey(startMint), "confirmed");
  if (!quoteMintInfo) throw new Error("Quote mint unavailable on local fork");
  const rpc = await fetch(localUrl, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "surfnet_setTokenAccount",
      params: [wallet.publicKey.toBase58(), startMint,
        { amount: Number(fundedAtoms), state: "initialized" }, quoteMintInfo.owner.toBase58()] }) });
  const changed = await rpc.json() as { error?: { message?: string } };
  if (!rpc.ok || changed.error) throw new Error(changed.error?.message ?? "Local quote funding failed");
  stage = "buy instructions";
  const localPump = new PumpPurchaseQuotes(local, new RaydiumFundingQuotes(mainnet));
  const instructions = direct
    ? await localPump.buildBuyInstructions(candidate, wallet.publicKey, fundedAtoms)
    : (await localPump.buildNestedBuyInstructions(nested!, wallet.publicKey, fundedAtoms)).instructions;
  const accounts = [...new Map(instructions.flatMap((instruction) => instruction.keys)
    .map((account) => [account.pubkey.toBase58(), account.pubkey])).values()];
  for (let index = 0; index < accounts.length; index += 20)
    await local.getMultipleAccountsInfo(accounts.slice(index, index + 20), "confirmed");
  const latest = await local.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: latest.blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...instructions],
  }).compileToV0Message();
  const purchase = new VersionedTransaction(message);
  purchase.sign([wallet]);
  stage = "purchase simulation";
  const simulated = await local.simulateTransaction(purchase, { sigVerify: true, commitment: "confirmed" });
  if (simulated.value.err) throw new Error(`Simulation error ${JSON.stringify(simulated.value.err)};
    logs ${JSON.stringify(simulated.value.logs?.slice(-8))}`);
  process.stdout.write(JSON.stringify({ token, route: nested ? "nested" : "direct",
    quoteMint: startMint, quoteAtoms: fundedAtoms.toString(),
    purchaseSimulated: true, computeUnits: simulated.value.unitsConsumed, sent: false }) + "\n");
} catch (error) {
  const detail = error instanceof Error ? error.message
    .replace(/https?:\/\/[^\s"']+/g, "[rpc]")
    .replace(/[A-Za-z0-9_-]{48,}/g, "[id]").slice(0, 650) : "unknown";
  process.stderr.write(`Local funded Pump buy failed at ${stage}: ${detail}\n`);
  process.exitCode = 1;
}
