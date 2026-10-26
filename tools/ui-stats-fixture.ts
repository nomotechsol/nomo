import { Store } from "../src/store.js";
import { candidateKey } from "../src/domain.js";

const path = process.argv[2];
if (!path || !path.startsWith("/tmp/nomo-"))
  throw new Error("Provide a throwaway /tmp/nomo-*.db path");
const store = new Store(path);
try {
  for (let index = 0; index < 25; index++) {
    const chain = index % 3 === 0 ? "sol" as const : index % 3 === 1 ? "bsc" as const : "robinhood" as const;
    const launchpad = chain === "sol" ? "pumpfun" as const : chain === "bsc" ? "flap_tax" as const : "pons_v2" as const;
    const token = chain === "sol" ? `Mint${index}` : `0x${String(index + 1).padStart(40, "0")}`;
    const candidate = { chain, launchpad, token, pool: `Pool${index}`,
      graduationTx: `Tx${index}`, graduatedAt: Date.now() };
    store.addCandidate(candidate);
    const id = candidateKey(candidate);
    store.updateCandidate(id, "eligible", []);
    store.reserveCandidate(id);
    store.db.prepare(`INSERT INTO execution_jobs(candidate_id, stage, data_json, updated_at)
      VALUES (?, 'published', ?, ?)`).run(id, JSON.stringify({ spendAtoms: chain === "sol" ? "100000000" :
        chain === "bsc" ? "50000000000000000" : "20000000000000000", budgetLamports: "100000000" }), Date.now());
    store.recordRound({ candidateId: id, purchaseTx: `Buy${index}`, receivedAtoms: 1_000_000n,
      rewardDecimals: 6, snapshotSlot: 1, holders: [{ solWallet: "FixtureHolder", rawBalance: 1_000_000n }] });
    store.putTokenMetadata(chain, token, { name: `Fixture token ${index + 1}`, symbol: `FIX${index + 1}`,
      imageUrl: null, fetchedAt: Date.now(), expiresAt: Date.now() + 60_000 });
  }
  process.stdout.write(`Seeded 25 test purchases in ${path}\n`);
} finally { store.close(); }
