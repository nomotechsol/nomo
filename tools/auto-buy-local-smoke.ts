import "dotenv/config";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { SolanaBuyExecutor } from "../src/execution/solana-buy.js";
import { Store } from "../src/store.js";

const token = process.argv[2];
if (!token || !process.env.HELIUS_RPC_URL) throw new Error("Token and HELIUS_RPC_URL are required");
const source = new Store(process.env.DATABASE_PATH ?? "./data/nomo.db");
const candidate = source.listCandidates(10_000).find((row) => row.candidate.token === token)?.candidate;
source.close();
if (!candidate || candidate.chain !== "sol") throw new Error("Verified Solana candidate is absent from cache");

const local = new Connection(process.env.LOCAL_SOLANA_RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
// Surfpool can fail to lazy-load a large Raydium/PumpSwap transaction. Clone every
// explicitly referenced account before its simulation and local submission.
const preload = async (transaction: VersionedTransaction) => {
  const keys: PublicKey[] = [...transaction.message.staticAccountKeys];
  for (const lookup of transaction.message.addressTableLookups) {
    const table = (await local.getAddressLookupTable(lookup.accountKey)).value;
    if (!table) throw new Error("Local fork address lookup table unavailable");
    for (const index of [...lookup.writableIndexes, ...lookup.readonlyIndexes]) {
      const key = table.state.addresses[index];
      if (!key) throw new Error("Local fork address lookup index unavailable");
      keys.push(key);
    }
  }
  const unique = [...new Map(keys.map((key) => [key.toBase58(), key])).values()];
  for (let index = 0; index < unique.length; index += 20)
    await local.getMultipleAccountsInfo(unique.slice(index, index + 20), "confirmed");
};
const simulate = local.simulateTransaction.bind(local);
local.simulateTransaction = (async (transaction: VersionedTransaction, options: Parameters<typeof simulate>[1]) => {
  await preload(transaction);
  return simulate(transaction, options);
}) as typeof local.simulateTransaction;
const sendRaw = local.sendRawTransaction.bind(local);
local.sendRawTransaction = (async (raw: Buffer | Uint8Array | number[], options?: Parameters<typeof sendRaw>[1]) => {
  // The production buyer reaches this call only after a signed simulation succeeds.
  // Stop here when checking every cached candidate without mutating the fork.
  if (process.env.SIMULATION_ONLY === "1") throw new Error("LOCAL_SIMULATION_PASSED");
  await preload(VersionedTransaction.deserialize(Buffer.from(raw)));
  return sendRaw(raw, options);
}) as typeof local.sendRawTransaction;
const mainnet = new Connection(process.env.HELIUS_RPC_URL, "finalized");
const wallet = Keypair.generate(); // Ephemeral signer for a local fork only; never persisted.
const store = new Store(":memory:");
try {
  const airdrop = await local.requestAirdrop(wallet.publicKey, 2_000_000_000);
  await local.confirmTransaction(airdrop, "confirmed");
  store.addCandidate(candidate);
  const row = store.listCandidates()[0]!;
  store.updateCandidate(row.id, "eligible", []);
  store.startJob(row.id);
  store.advanceJob(row.id, "reserved", "snapshotted", { budgetLamports: "10000000" });
  const signer = { publicKey: wallet.publicKey, async sign(transaction: VersionedTransaction) {
    transaction.sign([wallet]);
    return transaction;
  } };
  const buyer = new SolanaBuyExecutor(store, mainnet, local, signer);
  const result = await buyer.buy(`${row.id}:buy`, candidate, 10_000_000n);
  store.advanceJob(row.id, "snapshotted", "purchased", {
    ...store.getJob(row.id)!.data, purchaseTx: result.tx,
    purchasedAtoms: result.receivedAtoms.toString(), rewardDecimals: result.rewardDecimals,
  });
  process.stdout.write(JSON.stringify({ cluster: "local Surfpool fork", token,
    purchaseTx: result.tx, receivedAtoms: result.receivedAtoms.toString(),
    journalStage: store.getJob(row.id)?.stage }) + "\n");
} catch (error) {
  if (error instanceof Error && error.message === "LOCAL_SIMULATION_PASSED") {
    const plan = store.getJob(store.listCandidates()[0]!.id)?.data.buyPlan as
      { kind?: string; unsignedFunding?: string[] } | undefined;
    process.stdout.write(JSON.stringify({ cluster: "local Surfpool fork", token,
      simulated: true, step: plan?.kind === "stonk" || !plan?.unsignedFunding?.length
        ? "purchase" : "funding",
      routeKind: plan?.kind, sent: false }) + "\n");
    process.exitCode = 0;
  } else {
  const detail = error instanceof Error ? error.message
    .replace(/https?:\/\/[^\s"']+/g, "[rpc]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[id]").slice(0, 500) : "unknown error";
  process.stderr.write(`Local auto-buy test failed: ${detail}\n`);
  process.exitCode = 1;
  }
} finally {
  store.close();
}
