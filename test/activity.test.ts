import { describe, expect, it } from "vitest";
import { disabledFilters, type Candidate } from "../src/domain.js";
import { readyForActivity, readyForMetadata } from "../src/activity.js";
import { fromFlapMetadataUri, fromFourMeme, fromHeliusAsset } from "../src/token-metadata.js";
import type { CandidateRow, TokenMetadata } from "../src/store.js";

const now = 1_000_000;
const filters = { ...disabledFilters, pumpfun: { enabled: true, minTotalFeesNative: 1,
  maxFeeMetricsAgeSeconds: 120 } };
const candidate: Candidate = { chain: "sol", launchpad: "pumpfun", token: "mint", pool: "pool",
  quoteMint: "quote", graduationTx: "signature", graduatedAt: now - 10_000, isMayhemMode: false };
const row = (state: CandidateRow["state"], overrides: Partial<Candidate> = {}): CandidateRow => ({
  id: "candidate", candidate: { ...candidate, ...overrides }, state, reasons: [], observedAt: now,
});
const metadata: TokenMetadata = { name: "Example", symbol: "EX", imageUrl: null,
  fetchedAt: now, expiresAt: now + 60_000 };

describe("public activity qualification", () => {
  it("does not publish detected tokens, pending fees, failed thresholds, or absent metadata", () => {
    expect(readyForActivity(row("detected", { totalFeesNative: 5, feeMetricsAt: now }), filters, metadata, now))
      .toBe(false);
    expect(readyForMetadata(row("needs_data"), filters, now)).toBe(false);
    expect(readyForActivity(row("eligible"), filters, metadata, now)).toBe(false);
    expect(readyForActivity(row("eligible", { totalFeesNative: 0.9, feeMetricsAt: now }), filters, metadata, now))
      .toBe(false);
    expect(readyForActivity(row("eligible", { totalFeesNative: 1.2, feeMetricsAt: now }), filters, null, now))
      .toBe(false);
  });

  it("fetches metadata only after verified fees and publishes once name and symbol exist", () => {
    const qualified = row("eligible", { totalFeesNative: 1.2, feeMetricsAt: now });
    expect(readyForMetadata(qualified, filters, now)).toBe(true);
    expect(readyForActivity(qualified, filters, metadata, now)).toBe(true);
    expect(readyForActivity(qualified, filters, { ...metadata, symbol: null }, now)).toBe(false);
    expect(readyForActivity(qualified, filters, metadata, now + 121_000)).toBe(false);
  });

  it("hides pre-launch graduates from the live feed even if discovered after activation", () => {
    const qualified = row("eligible", { totalFeesNative: 1.2, feeMetricsAt: now });
    const startAt = now - 5_000;
    expect(qualified.observedAt).toBeGreaterThan(startAt);
    expect(readyForActivity(qualified, filters, metadata, now, startAt)).toBe(false);
    expect(readyForMetadata(qualified, filters, now, metadata, startAt)).toBe(false);
    const newGraduate = { ...qualified, candidate: { ...qualified.candidate, graduatedAt: startAt + 1 } };
    expect(readyForActivity(newGraduate, filters, metadata, now, startAt)).toBe(true);
  });

  it("keeps a fresh token visible across a brief metrics gap, then removes unbought graduates", () => {
    const stale = { ...row("rejected", { totalFeesNative: 1.2, feeMetricsAt: now }),
      reasons: ["fee_metrics_stale"] };
    expect(readyForActivity(stale, filters, metadata, now + 121_000)).toBe(true);
    expect(readyForMetadata(stale, filters, now + 121_000, metadata)).toBe(true);
    expect(readyForActivity(stale, filters, metadata, now + 5 * 60_000)).toBe(false);
    expect(readyForMetadata(stale, filters, now + 5 * 60_000, metadata)).toBe(false);
    expect(readyForActivity({ ...stale, state: "settled" }, filters, metadata, now + 5 * 60_000))
      .toBe(true);
    expect(readyForActivity({ ...stale, reasons: ["total_fees_native_below_min"] },
      filters, metadata, now + 121_000)).toBe(false);
    expect(readyForActivity({ ...stale, candidate: { ...stale.candidate, totalFeesNative: 0.9 } },
      filters, metadata, now + 121_000)).toBe(false);
  });

  it("uses BNB and RH fee units for their respective launchpads", () => {
    const evmFilters = { ...disabledFilters, fourmeme: { enabled: true, minTotalFeesNative: 0.15 },
      pons_v2: { enabled: true, minTotalFeesNative: 0.042934 } };
    const evmBase = { ...candidate, token: "0xToken", pool: "0xPool", quoteMint: undefined,
      quoteToken: "0xQuote", isMayhemMode: undefined };
    const bsc: CandidateRow = { ...row("eligible"), candidate: { ...evmBase, chain: "bsc",
      launchpad: "fourmeme", totalFeesNative: 0.15, feeMetricsAt: now } };
    const rh: CandidateRow = { ...row("eligible"), candidate: { ...evmBase, chain: "robinhood",
      launchpad: "pons_v2", totalFeesNative: 0.06, feeMetricsAt: now } };
    expect(readyForActivity(bsc, evmFilters, metadata, now)).toBe(true);
    expect(readyForActivity(rh, evmFilters, metadata, now)).toBe(true);
    expect(readyForActivity({ ...rh, candidate: { ...rh.candidate, totalFeesNative: 0.04 } },
      evmFilters, metadata, now)).toBe(false);
  });
});

describe("Flap on-chain metadata URI", () => {
  it("reads the original token metadata JSON and image without an aggregator", async () => {
    let requestedUrl = "";
    const request = (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return Response.json({ name: "  Example ", symbol: "EX",
        image: "ipfs://bafkreihncqyhp5koqfs2pwdtqoo4jkxunbqo62nxidxbuxvhj6u3z2yeua" });
    }) as typeof fetch;
    expect(await fromFlapMetadataUri("https://gg.sc/metadata/example.json", request)).toEqual({
      name: "Example", symbol: "EX",
      imageUrl: "https://gateway.pinata.cloud/ipfs/bafkreihncqyhp5koqfs2pwdtqoo4jkxunbqo62nxidxbuxvhj6u3z2yeua",
    });
    expect(requestedUrl).toBe("https://gg.sc/metadata/example.json");
  });
});

describe("Helius Solana asset metadata", () => {
  it("takes name, symbol, and image only from the requested mint", async () => {
    const request = (async (_url: string | URL | Request, options?: RequestInit) => {
      const id = JSON.parse(String(options?.body)).params.id;
      expect(JSON.parse(String(options?.body))).toMatchObject({ method: "getAsset",
        params: { id, displayOptions: { showFungible: true } } });
      return Response.json({ result: { id: "MintA", content: { metadata: {
        name: "Example", symbol: "EX" }, links: { image: "https://issuer.example/token.png" } } } });
    }) as typeof fetch;
    expect(await fromHeliusAsset("https://rpc.example", "MintA", request)).toEqual({
      name: "Example", symbol: "EX", imageUrl: "https://issuer.example/token.png",
    });
    await expect(fromHeliusAsset("https://rpc.example", "MintB", request))
      .rejects.toThrow("token mismatch");
  });
});

describe("Four.meme token image", () => {
  it("uses the platform's own record only when its address matches", async () => {
    const request = (async () => Response.json({ code: 0, data: { address: "0xToken",
      name: "Example", shortName: "EX", image: "https://static.four.meme/example.png" } })) as typeof fetch;
    expect(await fromFourMeme("0xToken", request)).toEqual({ name: "Example", symbol: "EX",
      imageUrl: "https://static.four.meme/example.png" });
    await expect(fromFourMeme("0xOther", request)).rejects.toThrow("address mismatch");
  });
});
