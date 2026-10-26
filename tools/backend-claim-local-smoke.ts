import "dotenv/config";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccount, createMint, mintTo } from "@solana/spl-token";
import { BackendSolanaClaims } from "../src/claims/solana-transaction.js";
import { deterministicRoundId } from "../src/execution/engine.js";
import { SolanaExecutionAdapter } from "../src/execution/solana-adapter.js";
import { Store } from "../src/store.js";

const localUrl = process.argv[2] ?? "http://127.0.0.1:8899";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(localUrl))
  throw new Error("This smoke test only accepts a local validator on 127.0.0.1");
const local = new Connection(localUrl, "confirmed");
const treasury = Keypair.generate();
const reward = Keypair.generate();
const claimant = Keypair.generate();
const signer = (wallet: Keypair) => ({ publicKey: wallet.publicKey,
  async sign(transaction: VersionedTransaction) { transaction.sign([wallet]); return transaction; } });
const store = new Store(":memory:");
try {
  for (const wallet of [treasury, reward, claimant]) {
    const signature = await local.requestAirdrop(wallet.publicKey, 2_000_000_000);
    await local.confirmTransaction(signature, "confirmed");
  }
  const mint = await createMint(local, treasury, treasury.publicKey, null, 6);
  const treasuryAta = await createAssociatedTokenAccount(local, treasury, mint, treasury.publicKey);
  await mintTo(local, treasury, mint, treasuryAta, treasury, 1_000_000_000n);
  const token = mint.toBase58();
  const candidate = { chain: "sol" as const, launchpad: "pumpfun" as const,
    token, pool: mint.toBase58(), graduatedAt: Date.now() };
  store.addCandidate(candidate);
  const row = store.listCandidates()[0]!;
  store.updateCandidate(row.id, "eligible", []);
  store.startJob(row.id);
  store.advanceJob(row.id, "reserved", "purchased", { snapshotSlot: 1,
    holders: [{ solWallet: claimant.publicKey.toBase58(), rawBalance: "1000000" }],
    budgetLamports: "10000000", purchaseTx: "local-mint", purchasedAtoms: "1000000000",
    rewardDecimals: 6 });
  const purchase = { tx: "local-mint", receivedAtoms: 1_000_000_000n, rewardDecimals: 6 };
  const holderAtoms = purchase.receivedAtoms * 70n / 100n;
  const ownerAtoms = purchase.receivedAtoms - holderAtoms;
  const adapter = new SolanaExecutionAdapter(store, localUrl, local,
    signer(treasury), signer(reward), candidate.token);
  const funded = await adapter.fund(`${row.id}:fund`, candidate, purchase, holderAtoms, ownerAtoms);
  store.advanceJob(row.id, "purchased", "funded", { ...store.getJob(row.id)!.data,
    fundedAtoms: funded.creditedAtoms.toString() });
  store.recordRound({ candidateId: row.id, purchaseTx: purchase.tx,
    receivedAtoms: funded.creditedAtoms, rewardDecimals: purchase.rewardDecimals,
    snapshotSlot: 1, holders: [{ solWallet: claimant.publicKey.toBase58(), rawBalance: 1_000_000n }] });
  store.advanceJob(row.id, "funded", "recorded", store.getJob(row.id)!.data);
  const publication = await adapter.publish(`${row.id}:publish`, candidate, deterministicRoundId(row.id),
    store.allocationsForRound(row.id), funded.creditedAtoms);
  store.publishRound(row.id, publication.root, publication.tx, publication.claimTarget);
  const claims = new BackendSolanaClaims(store, local, signer(reward), "localnet");
  const prepared = await claims.prepare(row.id, claimant.publicKey.toBase58());
  const repeated = await claims.prepare(row.id, claimant.publicKey.toBase58());
  assert.equal(repeated.transactionBase64, prepared.transactionBase64);
  const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.transactionBase64, "base64"));
  transaction.sign([claimant]);
  const signature = bs58.encode(transaction.signatures[0]!);
  await local.sendRawTransaction(transaction.serialize(), { skipPreflight: false });
  await local.confirmTransaction({ signature, blockhash: transaction.message.recentBlockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight }, "confirmed");
  const claimed = await claims.finalize(row.id, claimant.publicKey.toBase58(), signature);
  assert.equal(claimed.claimed, true);
  assert.equal(store.getSolanaClaim(row.id, claimant.publicKey.toBase58())?.state, "claimed");
  await assert.rejects(() => claims.prepare(row.id, claimant.publicKey.toBase58()), /already claimed/);
  process.stdout.write(JSON.stringify({ token, purchaseTx: purchase.tx,
    fundingTx: funded.tx, claimTx: signature, receivedAtoms: purchase.receivedAtoms.toString(),
    rewardAtoms: funded.creditedAtoms.toString(), ownerAtoms: ownerAtoms.toString(),
    claimState: "claimed", cluster: "local validator" }) + "\n");
} finally { store.close(); }
