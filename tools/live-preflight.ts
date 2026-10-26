import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";
import { Store } from "../src/store.js";
import { BackendSolanaSigner } from "../src/execution/backend-solana-signer.js";
import { BackendEvmSigner } from "../src/execution/backend-evm-signer.js";
import { SolanaExecutionAdapter } from "../src/execution/solana-adapter.js";
import { BscExecutionAdapter } from "../src/execution/bsc-adapter.js";
import { RaydiumFundingQuotes } from "../src/execution/solana-routes.js";
import { RelayBridgeQuotes } from "../src/execution/relay-bridge.js";
import { finalizedHolderSnapshot } from "../src/solana/snapshot.js";
import type { Candidate, Chain, FilterSet } from "../src/domain.js";

const require = createRequire(import.meta.url);
const { canonicalPumpPoolPdaWithQuote } = require("@pump-fun/pump-sdk") as
  typeof import("@pump-fun/pump-sdk");
const PUMP = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
const SOL = new PublicKey("So11111111111111111111111111111111111111112");
const store = new Store(process.env.DATABASE_PATH ?? "./data/nomo.db");
const failures: string[] = [];
const warnings: string[] = [];
const ok = (name: string, detail: string) => console.log(`PASS ${name}: ${detail}`);
const fail = (name: string, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  failures.push(`${name}: ${message}`);
  console.error(`FAIL ${name}: ${message}`);
};
const warn = (name: string, detail: string) => {
  warnings.push(`${name}: ${detail}`);
  console.warn(`WARN ${name}: ${detail}`);
};
const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing`);
  return value;
};
const privateFile = (name: string): string => {
  const path = resolve(required(name));
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${name} must have mode 0600`);
  if (path.startsWith(`${process.cwd()}/`)) throw new Error(`${name} must be outside the repository`);
  return path;
};
const candidateFor = (chain: Chain): Candidate => ({ chain,
  launchpad: chain === "bsc" ? "flap_tax" : "pons_v2", token: "preflight",
  pool: "preflight", graduationTx: "preflight", graduatedAt: Date.now() });

try {
  if (process.env.SOLANA_CLUSTER !== "mainnet") throw new Error("SOLANA_CLUSTER must be mainnet");
  const rpc = required("HELIUS_RPC_URL");
  const mint = new PublicKey(required("MAIN_TOKEN_MINT"));
  const lp = new PublicKey(required("MAIN_TOKEN_LP_POOL"));
  const canonical = canonicalPumpPoolPdaWithQuote(mint, PUMP);
  if (!lp.equals(canonical)) throw new Error("LP address differs from the canonical NOMO/PUMP pool");
  ok("NOMO identity", `mint ${mint.toBase58()}, canonical LP ${lp.toBase58()}`);

  const filterFile = process.env.FILTERS_FILE;
  const filters = filterFile ? JSON.parse(readFileSync(filterFile, "utf8")) as FilterSet : store.getFilters();
  for (const name of ["pumpfun", "stonkfun", "flap_tax", "flap_nontax", "fourmeme", "pons_v2"] as const) {
    const rule = filters[name];
    if (!rule?.enabled || !rule.minTotalFeesNative || !rule.maxFeeMetricsAgeSeconds)
      throw new Error(`${name} fee filter is disabled or incomplete`);
  }
  ok("filters", "all six launchpad modes have fee thresholds and freshness limits");
  if (store.getActiveJob()) throw new Error("an unfinished purchase job requires reconciliation");
  ok("journal", "no unfinished purchase job");

  const connection = new Connection(rpc, "confirmed");
  const treasury = BackendSolanaSigner.fromFile(privateFile("SOLANA_TREASURY_KEYPAIR_PATH"));
  const reward = BackendSolanaSigner.fromFile(privateFile("SOLANA_REWARD_KEYPAIR_PATH"));
  const sol = new SolanaExecutionAdapter(store, rpc, connection, treasury, reward,
    mint.toBase58(), lp.toBase58());
  let solReady = true;
  try { await sol.assertReady(); }
  catch (error) { fail("Solana readiness", error); solReady = false; }
  const [poolAccount, treasuryLamports, rewardLamports] = await Promise.all([
    connection.getAccountInfo(lp, "finalized"),
    connection.getBalance(treasury.publicKey, "finalized"),
    connection.getBalance(reward.publicKey, "finalized"),
  ]);
  if (solReady) ok("Solana fee authority", `creator matches treasury; PUMP quote; LP ${poolAccount ? "deployed" : "not yet deployed"}`);
  ok("Solana wallets", `treasury ${treasury.publicKey.toBase58()}, reward ${reward.publicKey.toBase58()}`);
  if (treasuryLamports < 4_000_000_000)
    warn("treasury balance", `${(treasuryLamports / 1e9).toFixed(4)} SOL; a 1 SOL minimum buy needs about 4 SOL before fees`);
  else ok("treasury balance", `${(treasuryLamports / 1e9).toFixed(4)} SOL`);
  if (rewardLamports < 50_000_000)
    warn("reward balance", `${(rewardLamports / 1e9).toFixed(4)} SOL; many recipient ATAs need more rent`);
  else ok("reward balance", `${(rewardLamports / 1e9).toFixed(4)} SOL`);

  try {
    const snapshot = await finalizedHolderSnapshot({ rpcUrl: rpc, mainMint: mint.toBase58(),
      extraExcludedAccounts: [lp.toBase58()] });
    ok("holder snapshot", `finalized slot ${snapshot.slot}, ${snapshot.holders.length} eligible wallets`);
  } catch (error) {
    if (error instanceof Error && error.message === "No eligible holders at finalized snapshot")
      warn("holder snapshot", "RPC responded but there are no eligible 1,000,000 NOMO holders yet");
    else fail("holder snapshot", error);
  }

  try {
    const pumpMint = await getMint(connection, PUMP, "confirmed", TOKEN_2022_PROGRAM_ID);
    await new RaydiumFundingQuotes(connection).quotePair(PUMP, SOL,
      10n ** BigInt(pumpMint.decimals), 9900);
    ok("PUMP to SOL", "read-only Raydium route quote succeeded");
  } catch (error) { fail("PUMP to SOL", error); }

  const gmgnKey = required("GMGN_API_KEY");
  const probe = store.listCandidates(1)[0]?.candidate;
  if (probe) {
    const params = new URLSearchParams({ chain: probe.chain, address: probe.token,
      timestamp: String(Math.floor(Date.now() / 1000)), client_id: randomUUID() });
    try {
      const response = await fetch(`https://openapi.gmgn.ai/v1/token/info?${params}`, {
        headers: { "X-APIKEY": gmgnKey }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok && response.status !== 404) throw new Error(`GMGN HTTP ${response.status}`);
      ok("GMGN", `token/info HTTP ${response.status}`);
    } catch (error) { fail("GMGN", error); }
  } else warn("GMGN", "key is set; no cached candidate is available for a read-only request");

  const bridge = new RelayBridgeQuotes();
  for (const chain of ["bsc", "robinhood"] as const) {
    const prefix = chain === "bsc" ? "BSC" : "RH";
    try {
      const evmRpc = required(`${prefix}_RPC_URL`);
      const evmTreasury = BackendEvmSigner.fromFile(privateFile(`${prefix}_TREASURY_KEY_PATH`));
      const evmReward = BackendEvmSigner.fromFile(privateFile(`${prefix}_REWARD_KEY_PATH`));
      const adapter = new BscExecutionAdapter(store, sol, connection, treasury, evmRpc,
        evmTreasury, evmReward, undefined, chain);
      await adapter.assertReady();
      ok(`${prefix} RPC and wallets`, `chain ID verified; treasury ${evmTreasury.account.address}, reward ${evmReward.account.address}`);
      const quote = await bridge.quote(candidateFor(chain), 1_000_000_000n,
        treasury.publicKey.toBase58(), evmTreasury.account.address);
      ok(`${prefix} bridge`, `read-only 1 SOL quote; minimum destination ${quote.minimumNativeAtoms.toString()} atoms`);
    } catch (error) { fail(`${prefix} execution`, error); }
  }
} catch (error) { fail("configuration", error); }
finally {
  store.close();
  console.log(`Preflight: ${failures.length} failure(s), ${warnings.length} warning(s). No transactions were signed or sent.`);
  if (failures.length) process.exitCode = 1;
}
