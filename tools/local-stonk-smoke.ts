import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { StonkPurchaseQuotes } from "../src/execution/solana-routes.js";
import { PURCHASE_SLIPPAGE_BPS } from "../src/execution/slippage.js";
import { Store } from "../src/store.js";

let stage = "initialization";
try {
  if (!process.env.HELIUS_RPC_URL) throw new Error("HELIUS_RPC_URL is required");
  const token = process.argv[2];
  if (!token) throw new Error("StonkFun token address is required");
  const store = new Store(process.env.DATABASE_PATH ?? "./data/nomo.db");
  const candidate = store.listCandidates(10_000).find((row) => row.candidate.token === token)?.candidate;
  store.close();
  if (!candidate || candidate.chain !== "sol" || candidate.launchpad !== "stonkfun" || !candidate.quoteMint)
    throw new Error("A verified StonkFun graduation is required");

  const local = new Connection(process.env.LOCAL_SOLANA_RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
  const mainnet = new Connection(process.env.HELIUS_RPC_URL, "finalized");
  const user = Keypair.generate(); // Ephemeral local-only signer, never saved.
  stage = "local airdrop";
  const airdrop = await local.requestAirdrop(user.publicKey, 2_000_000_000);
  await local.confirmTransaction(airdrop, "confirmed");

  const stonk = new StonkPurchaseQuotes(mainnet);
  const slippageBps = process.argv[3] ? Number(process.argv[3]) : PURCHASE_SLIPPAGE_BPS;
  stage = "Raydium quote";
  const quote = await stonk.quote(candidate, 10_000_000n, slippageBps);
  stage = "Raydium transaction build";
  const transactions = await stonk.buildUnsignedTransactions(quote, user.publicKey, 0n);
  for (const transaction of transactions) {
    stage = "local simulation";
    transaction.message.recentBlockhash = (await local.getLatestBlockhash("confirmed")).blockhash;
    transaction.sign([user]);
    const result = await local.simulateTransaction(transaction, { sigVerify: true, commitment: "confirmed" });
    if (result.value.err) {
      process.stderr.write(`Local Raydium result: ${JSON.stringify(result.value.err)}\n`);
      process.stderr.write(`Local Raydium logs: ${JSON.stringify(result.value.logs?.slice(-18) ?? [])}\n`);
      throw new Error("Local Raydium simulation failed");
    }
    stage = "local submission";
    const signature = await local.sendTransaction(transaction, { skipPreflight: true });
    stage = "local confirmation";
    const receipt = await local.confirmTransaction(signature, "confirmed");
    if (receipt.value.err) throw new Error(`Local Raydium swap failed: ${JSON.stringify(receipt.value.err)}`);
  }
  stage = "token balance check";
  const mint = new PublicKey(token);
  const mintInfo = await local.getAccountInfo(mint, "confirmed");
  if (!mintInfo || (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)))
    throw new Error("Target mint is missing or has an unsupported owner");
  const account = getAssociatedTokenAddressSync(mint, user.publicKey, false, mintInfo.owner);
  const received = (await getAccount(local, account, "confirmed", mintInfo.owner)).amount;
  if (received <= 0n) throw new Error("Local Raydium transaction received no target tokens");
  process.stdout.write(JSON.stringify({ cluster: "local Surfpool fork", target: token,
    routePools: quote.pools, receivedAtoms: received.toString(),
    fundingTransactions: transactions.length }) + "\n");
} catch (error) {
  // Provider errors can contain credential-bearing URLs.
  const detail = error instanceof Error ? error.message
    .replace(/https?:\/\/[^\s"']+/g, "[rpc]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[id]").slice(0, 400) : "unknown error";
  process.stderr.write(`Local StonkFun smoke failed at ${stage}: ${detail}\n`);
  process.exitCode = 1;
}
