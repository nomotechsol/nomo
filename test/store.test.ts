import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

describe("durable index state", () => {
  it("keeps token names, tickers and images after reopening SQLite", () => {
    const folder = mkdtempSync(join(tmpdir(), "nomo-metadata-"));
    const file = join(folder, "monitor.db");
    try {
      const first = new Store(file);
      first.putTokenMetadata("bsc", "0xAb", { name: "Example Token", symbol: "EX", imageUrl: "https://example.com/ex.png",
        fetchedAt: 100, expiresAt: 200 });
      first.close();
      const reopened = new Store(file);
      expect(reopened.getTokenMetadata("bsc", "0xab")).toEqual({ name: "Example Token", symbol: "EX",
        imageUrl: "https://example.com/ex.png", fetchedAt: 100, expiresAt: 200 });
      reopened.close();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it("deduplicates per chain and token, and never moves a cursor backwards", () => {
    const store = new Store(":memory:");
    const candidate = { chain: "bsc" as const, launchpad: "flap_tax" as const, token: "0xAb", pool: "0xPool",
      graduationTx: "0xTx", graduatedAt: 1 };
    expect(store.addCandidate(candidate)).toBe(true);
    expect(store.addCandidate({ ...candidate, launchpad: "flap_nontax", token: "0xab" })).toBe(false);
    expect(store.hasCandidate("bsc", "0xAB")).toBe(true);
    expect(store.listCandidates()).toHaveLength(1);
    store.setCursor("flap", 100n);
    expect(store.getCursor("flap")).toBe(100n);
    expect(() => store.setCursor("flap", 99n)).toThrow("backwards");
    store.close();
  });

  it("books only an eligible round and allocates the actual received amount exactly", () => {
    const store = new Store(":memory:");
    const candidate = { chain: "sol" as const, launchpad: "pumpfun" as const, token: "Mint", pool: "Pool",
      graduationTx: "Sig", graduatedAt: 1 };
    store.addCandidate(candidate);
    const id = "sol:pumpfun:Mint:Sig";
    const receipt = { candidateId: id, purchaseTx: "BuySig", receivedAtoms: 7n, rewardDecimals: 6, snapshotSlot: 100,
      holders: [{ solWallet: "A", rawBalance: 500_000n }, { solWallet: "B", rawBalance: 1_000_000n }] };
    expect(() => store.recordRound(receipt)).toThrow("not reserved");
    store.updateCandidate(id, "eligible", []);
    store.reserveCandidate(id);
    store.recordRound(receipt);
    expect(store.listRounds()[0]?.receivedAtoms).toBe("7");
    expect(store.allocationsForWallet("A")[0]?.rewardAtoms).toBe("2");
    expect(store.allocationsForWallet("B")[0]?.rewardAtoms).toBe("5");
    expect(store.rewardsForWallet("A")[0]?.rewardDecimals).toBe(6);
    expect(store.listCandidates()[0]?.state).toBe("settled");
    expect(() => store.recordRound(receipt)).toThrow();
    store.close();
  });

  it("keeps one prepared claim per holder and prevents replacing a confirmed claim", () => {
    const store = new Store(":memory:");
    store.addCandidate({ chain: "sol", launchpad: "pumpfun", token: "Mint", pool: "Pool",
      graduationTx: "Sig", graduatedAt: 1 });
    const id = "sol:pumpfun:Mint:Sig";
    store.updateCandidate(id, "eligible", []);
    store.startJob(id);
    store.recordRound({ candidateId: id, purchaseTx: "BuySig", receivedAtoms: 70n,
      rewardDecimals: 6, snapshotSlot: 100, holders: [{ solWallet: "A", rawBalance: 1n }] });
    store.advanceJob(id, "reserved", "recorded", {});
    store.publishRound(id, "root", "backend:publish", "RewardWallet");
    const first = { candidateId: id, solWallet: "A", transactionBase64: "first", signature: "sig1",
      lastValidBlockHeight: 100 };
    expect(store.savePreparedSolanaClaim(first)).toBe(true);
    expect(store.savePreparedSolanaClaim({ ...first, signature: "sig2" })).toBe(false);
    expect(store.savePreparedSolanaClaim({ ...first, signature: "sig2" }, "sig1")).toBe(true);
    expect(store.markSolanaClaimed(id, "A", "sig1")).toBe(false);
    expect(store.markSolanaClaimed(id, "A", "sig2")).toBe(true);
    expect(store.savePreparedSolanaClaim({ ...first, signature: "sig3" }, "sig2")).toBe(false);
    expect(store.getSolanaClaim(id, "A")?.state).toBe("claimed");
    store.close();
  });
});
