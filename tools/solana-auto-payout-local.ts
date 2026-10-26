import { strict as assert } from "node:assert";
import { Connection, Keypair } from "@solana/web3.js";
import { createMint, getAccount, getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Store } from "../src/store.js";
import { SolanaAutoDistributor } from "../src/execution/solana-auto-distributor.js";

const rpc = process.argv[2] ?? "http://127.0.0.1:18999";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc))
  throw new Error("This smoke test only accepts a local validator on 127.0.0.1");
const holderCount = Number(process.argv[3] ?? 5);
if (!Number.isSafeInteger(holderCount) || holderCount < 1 || holderCount > 100)
  throw new Error("Holder count must be between 1 and 100");
const connection = new Connection(rpc, "confirmed");
const payer = Keypair.generate();
const reward = Keypair.generate();
for (const wallet of [payer, reward]) {
  const signature = await connection.requestAirdrop(wallet.publicKey, 2_000_000_000);
  await connection.confirmTransaction(signature, "confirmed");
}
const mint = await createMint(connection, payer, payer.publicKey, null, 6);
const rewardAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, reward.publicKey);
await mintTo(connection, payer, mint, rewardAta.address, payer, 700_000_000n);
const holders = Array.from({ length: holderCount }, () => Keypair.generate().publicKey.toBase58());
const store = new Store(":memory:");
const candidate = { chain: "sol" as const, launchpad: "pumpfun" as const, token: mint.toBase58(),
  pool: Keypair.generate().publicKey.toBase58(), graduationTx: "local", graduatedAt: Date.now() };
store.addCandidate(candidate);
const id = `sol:pumpfun:${candidate.token}:local`;
store.updateCandidate(id, "eligible", []);
store.startJob(id);
store.recordRound({ candidateId: id, purchaseTx: "local-buy", receivedAtoms: 700_000_000n,
  rewardDecimals: 6, snapshotSlot: 1, holders: holders.map((solWallet) =>
    ({ solWallet, rawBalance: 1_000_000n })) });
store.advanceJob(id, "reserved", "recorded", {});
store.publishRound(id, "local-root", "local-publish", reward.publicKey.toBase58(), undefined, "push");
const signer = { publicKey: reward.publicKey, async sign(tx: import("@solana/web3.js").VersionedTransaction) {
  tx.sign([reward]); return tx;
} };
const distributor = new SolanaAutoDistributor(store, connection, signer);
const signatures: string[] = [];
while (true) {
  const signature = await distributor.tick();
  if (!signature) break;
  signatures.push(signature);
}
assert.equal(signatures.length, Math.ceil(holderCount / 4));
assert.equal(new Set(signatures).size, signatures.length);
let total = 0n;
for (const wallet of holders) {
  const ata = getAssociatedTokenAddressSync(mint, new (await import("@solana/web3.js")).PublicKey(wallet));
  const account = await getAccount(connection, ata);
  const expected = store.allocationsForWallet(wallet)[0]!.rewardAtoms;
  assert.equal(account.amount.toString(), expected);
  assert.equal(store.getSolanaPayout(id, wallet)?.state, "sent");
  total += account.amount;
}
assert.equal(total, 700_000_000n);
assert.equal((await getAccount(connection, rewardAta.address)).amount, 0n);
store.close();
process.stdout.write(`Local payout verified: ${holders.length} holders, ${signatures.length} transactions, 70% holder pool delivered.\n`);
