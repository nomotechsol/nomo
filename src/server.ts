import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import staticPlugin from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";
import { type FilterSet, disabledFilters, evaluateCandidate, missingCandidateData } from "./domain.js";
import { EvmGraduationScanner } from "./evm/scanner.js";
import { SolanaDiscovery } from "./solana/discovery.js";
import { confirmWalletLink, createWalletLinkChallenge } from "./claims/link.js";
import { claimProof } from "./claims/proofs.js";
import { BackendSolanaClaims } from "./claims/solana-transaction.js";
import { BackendBscClaims } from "./claims/bsc-transfer.js";
import { Store } from "./store.js";
import { GmgnFeeEnricher } from "./gmgn/fees.js";
import { GmgnBscDiscovery } from "./gmgn/bsc-discovery.js";
import { GmgnRhDiscovery } from "./gmgn/rh-discovery.js";
import { getOrFetchTokenMetadata } from "./token-metadata.js";
import { TokenImageCache } from "./token-images.js";
import { readyForActivity, readyForMetadata } from "./activity.js";
import { buildStatsSummary, cachedSpotQuotes, type SpotQuotes } from "./stats.js";
import { ExecutionEngine } from "./execution/engine.js";
import { SolanaExecutionAdapter } from "./execution/solana-adapter.js";
import { BackendSolanaSigner } from "./execution/backend-solana-signer.js";
import { SolanaAutoDistributor } from "./execution/solana-auto-distributor.js";
import { BackendEvmSigner } from "./execution/backend-evm-signer.js";
import { BscExecutionAdapter } from "./execution/bsc-adapter.js";
import { CreatorFeeCollector } from "./execution/creator-fee-collector.js";
import type { ExecutionAdapter } from "./execution/engine.js";

const liveSolana = process.env.LIVE_TRADING === "true";
const liveBsc = process.env.LIVE_BSC_TRADING === "true";
const liveRh = process.env.LIVE_RH_TRADING === "true";
if (liveSolana && (!process.env.HELIUS_RPC_URL || !process.env.MAIN_TOKEN_MINT ||
    !process.env.MAIN_TOKEN_LP_POOL || !process.env.SOLANA_TREASURY_KEYPAIR_PATH ||
    !process.env.SOLANA_REWARD_KEYPAIR_PATH))
  throw new Error("Live Solana execution requires RPC, NOMO mint, canonical NOMO/PUMP LP pool and private backend keypair paths");
if (liveBsc && (!liveSolana || !process.env.BSC_RPC_URL || !process.env.BSC_TREASURY_KEY_PATH ||
    !process.env.BSC_REWARD_KEY_PATH))
  throw new Error("Live BNB execution requires Solana live mode, BNB RPC and private EVM key files");
if (liveRh && (!liveSolana || !process.env.RH_RPC_URL || !process.env.RH_TREASURY_KEY_PATH ||
    !process.env.RH_REWARD_KEY_PATH))
  throw new Error("Live RH execution requires Solana live mode, RH RPC and private EVM key files");

const rule = z.object({
  enabled: z.boolean(),
  minMarketCapUsd: z.number().nonnegative().optional(), maxMarketCapUsd: z.number().nonnegative().optional(),
  minLiquidityUsd: z.number().nonnegative().optional(), minHolders: z.number().int().nonnegative().optional(),
  minVolumeUsd1h: z.number().nonnegative().optional(),
  maxTop10Rate: z.number().min(0).max(1).optional(), maxBundlerRate: z.number().min(0).max(1).optional(),
  maxInsiderRate: z.number().min(0).max(1).optional(), maxTaxBps: z.number().int().min(0).max(10000).optional(),
  requireNotHoneypot: z.boolean().optional(), maxGraduationAgeSeconds: z.number().int().positive().optional(),
  minTotalFeesNative: z.number().nonnegative().optional(), minTotalFeesUsd: z.number().nonnegative().optional(),
  maxFeeMetricsAgeSeconds: z.number().int().positive().optional(),
}).strict();
const filterSchema = z.object(Object.fromEntries(Object.keys(disabledFilters).map((name) => [name, rule])) as {
  [K in keyof FilterSet]: typeof rule;
}).strict();

const databasePath = process.env.DATABASE_PATH ?? "./data/nomo.db";
const store = new Store(databasePath);
const tokenImages = new TokenImageCache(resolve(dirname(databasePath), "token-images"),
  (host, message) => console.warn("token image cache", host, message));
function publicMetadata(metadata: { name: string | null; symbol: string | null; imageUrl: string | null;
  expiresAt: number }) {
  const imageUrl = tokenImages.publicUrl(metadata.imageUrl);
  return { name: metadata.name, symbol: metadata.symbol, imageUrl,
    expiresAt: metadata.imageUrl && !imageUrl ? Math.min(metadata.expiresAt, Date.now() + 10_000) : metadata.expiresAt };
}
if (process.env.FILTERS_FILE) {
  const raw = JSON.parse(readFileSync(process.env.FILTERS_FILE, "utf8")) as unknown;
  store.setFilters(filterSchema.parse(raw) as FilterSet);
}

const rhScanner = process.env.RH_RPC_URL ? new EvmGraduationScanner(store, {
  source: "pons_v2", rpcUrl: process.env.RH_RPC_URL,
  startBlock: process.env.RH_START_BLOCK ? BigInt(process.env.RH_START_BLOCK) : undefined,
}) : undefined;
const scanners = [
  process.env.BSC_RPC_URL && new EvmGraduationScanner(store, { source: "flap", rpcUrl: process.env.BSC_RPC_URL,
    startBlock: process.env.BSC_START_BLOCK ? BigInt(process.env.BSC_START_BLOCK) : undefined }),
  process.env.BSC_RPC_URL && new EvmGraduationScanner(store, { source: "fourmeme", rpcUrl: process.env.BSC_RPC_URL,
    startBlock: process.env.BSC_START_BLOCK ? BigInt(process.env.BSC_START_BLOCK) : undefined }),
  rhScanner,
].filter((value): value is EvmGraduationScanner => Boolean(value));
const solana = process.env.HELIUS_RPC_URL ? new SolanaDiscovery(store, process.env.HELIUS_RPC_URL, process.env.GMGN_API_KEY) : undefined;
const gmgnFees = process.env.GMGN_API_KEY ? new GmgnFeeEnricher(store, process.env.GMGN_API_KEY) : undefined;
const gmgnBsc = process.env.GMGN_API_KEY && process.env.BSC_RPC_URL && scanners.length >= 2
  ? new GmgnBscDiscovery(store, process.env.GMGN_API_KEY, process.env.BSC_RPC_URL,
    scanners[0]!, scanners[1]!) : undefined;
const gmgnRh = process.env.GMGN_API_KEY && process.env.RH_RPC_URL && rhScanner
  ? new GmgnRhDiscovery(store, process.env.GMGN_API_KEY, process.env.RH_RPC_URL, rhScanner) : undefined;
const solanaConnection = process.env.HELIUS_RPC_URL
  ? new Connection(process.env.HELIUS_RPC_URL, "confirmed") : undefined;
const treasurySigner = liveSolana ? BackendSolanaSigner.fromFile(process.env.SOLANA_TREASURY_KEYPAIR_PATH!) : undefined;
const rewardSigner = process.env.SOLANA_REWARD_KEYPAIR_PATH
  ? BackendSolanaSigner.fromFile(process.env.SOLANA_REWARD_KEYPAIR_PATH) : undefined;
const solanaAdapter = liveSolana ? new SolanaExecutionAdapter(store, process.env.HELIUS_RPC_URL!,
    solanaConnection!, treasurySigner!, rewardSigner!, process.env.MAIN_TOKEN_MINT!,
    process.env.MAIN_TOKEN_LP_POOL!) : undefined;
const bscAdapter = liveBsc && solanaAdapter && solanaConnection && treasurySigner
  ? new BscExecutionAdapter(store, solanaAdapter, solanaConnection, treasurySigner,
    process.env.BSC_RPC_URL!, BackendEvmSigner.fromFile(process.env.BSC_TREASURY_KEY_PATH!),
    BackendEvmSigner.fromFile(process.env.BSC_REWARD_KEY_PATH!),
    process.env.BSC_GAS_RESERVE_WEI ? BigInt(process.env.BSC_GAS_RESERVE_WEI) : undefined) : undefined;
const rhAdapter = liveRh && solanaAdapter && solanaConnection && treasurySigner
  ? new BscExecutionAdapter(store, solanaAdapter, solanaConnection, treasurySigner,
    process.env.RH_RPC_URL!, BackendEvmSigner.fromFile(process.env.RH_TREASURY_KEY_PATH!),
    BackendEvmSigner.fromFile(process.env.RH_REWARD_KEY_PATH!),
    process.env.RH_GAS_RESERVE_WEI ? BigInt(process.env.RH_GAS_RESERVE_WEI) : undefined,
    "robinhood") : undefined;
const solanaClaims = solanaConnection && rewardSigner ? new BackendSolanaClaims(store, solanaConnection,
  rewardSigner, process.env.SOLANA_CLUSTER === "devnet" ? "devnet" :
    process.env.SOLANA_CLUSTER === "localnet" ? "localnet" : "mainnet") : undefined;
const solanaDistributor = liveSolana && solanaConnection && rewardSigner
  ? new SolanaAutoDistributor(store, solanaConnection, rewardSigner) : undefined;
const bscClaims = liveBsc ? new BackendBscClaims(store, process.env.BSC_RPC_URL!,
  BackendEvmSigner.fromFile(process.env.BSC_REWARD_KEY_PATH!)) : undefined;
const rhClaims = liveRh ? new BackendBscClaims(store, process.env.RH_RPC_URL!,
  BackendEvmSigner.fromFile(process.env.RH_REWARD_KEY_PATH!), "robinhood") : undefined;
const feeCollector = solanaAdapter ? new CreatorFeeCollector(store, solanaAdapter) : undefined;
let execution: ExecutionEngine | undefined;

const app = Fastify({ logger: true });
let polling = false;
let lastPollAt: number | null = null;
let lastPollError: string | null = null;
let lastPayoutError: string | null = null;
let lastFeeCollectionError: string | null = null;
let lastSolPollAt = 0;

function classify(): void {
  const filters = store.getFilters();
  for (const row of store.listCandidates(10_000)) {
    if (row.state === "reserved" || row.state === "settled") continue;
    if (row.candidate.chain === "sol" && row.candidate.token === process.env.MAIN_TOKEN_MINT) {
      if (row.state !== "rejected" || row.reasons[0] !== "project_mint")
        store.updateCandidate(row.id, "rejected", ["project_mint"]);
      continue;
    }
    const rule = filters[row.candidate.launchpad];
    const reasons = evaluateCandidate(row.candidate, rule, Date.now());
    const missing = missingCandidateData(row.candidate, rule);
    const state = reasons.includes("launchpad_disabled") || reasons.includes("mayhem_mode") ? "rejected" :
      missing.length > 0 ? "needs_data" :
      reasons.length ? "rejected" : "eligible";
    if (row.state !== state || JSON.stringify(row.reasons) !== JSON.stringify(reasons)) store.updateCandidate(row.id, state, reasons);
  }
}

async function hydrateQualifiedMetadata(): Promise<void> {
  const now = Date.now();
  const feedStartAt = store.getExecutionStartAt();
  const filters = store.getFilters();
  const rows = store.listCandidates(10_000).filter((row) => {
    const cached = store.getTokenMetadata(row.candidate.chain, row.candidate.token);
    if (!readyForMetadata(row, filters, now, cached, feedStartAt)) return false;
    return !cached || cached.expiresAt <= now;
  }).sort((a, b) => {
    const left = store.getTokenMetadata(a.candidate.chain, a.candidate.token)?.fetchedAt ?? 0;
    const right = store.getTokenMetadata(b.candidate.chain, b.candidate.token)?.fetchedAt ?? 0;
    return left - right;
  }).slice(0, 6);
  for (let offset = 0; offset < rows.length; offset += 2) {
    await Promise.allSettled(rows.slice(offset, offset + 2).map(async (row) => {
      const metadata = await getOrFetchTokenMetadata(store, row.candidate.chain, row.candidate.token);
      tokenImages.enqueue(metadata.imageUrl);
    }));
  }
}

function warmVisibleImages(): void {
  const filters = store.getFilters();
  const now = Date.now();
  const feedStartAt = store.getExecutionStartAt();
  for (const row of store.listCandidates(100)) {
    const metadata = store.getTokenMetadata(row.candidate.chain, row.candidate.token);
    if (readyForActivity(row, filters, metadata, now, feedStartAt)) tokenImages.enqueue(metadata?.imageUrl);
  }
}

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const errors: string[] = [];
    // Each source has its own durable cursor. A failing RPC cannot starve another chain.
    for (const scanner of scanners) {
      try { await scanner.poll(); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    if (gmgnBsc) {
      try { await gmgnBsc.poll(); }
      catch (error) { errors.push(`GMGN BNB discovery: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (gmgnRh) {
      try { await gmgnRh.poll(); }
      catch (error) { errors.push(`GMGN RH discovery: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (solana && Date.now() - lastSolPollAt >= 10_000) {
      lastSolPollAt = Date.now();
      try { await solana.start(); }
      catch (error) { errors.push(`Pump websocket: ${error instanceof Error ? error.message : String(error)}`); }
      try { await solana.poll(); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    if (gmgnFees) {
      try { await gmgnFees.poll(); }
      catch (error) { errors.push(`GMGN fees: ${error instanceof Error ? error.message : String(error)}`); }
    }
    classify();
    await hydrateQualifiedMetadata();
    warmVisibleImages();
    if (feeCollector && !store.getActiveJob()) {
      try {
        if (await feeCollector.tick()) lastFeeCollectionError = null;
      } catch (error) {
        lastFeeCollectionError = error instanceof Error ? error.message : String(error);
        errors.push(`NOMO creator fees: ${lastFeeCollectionError}`);
      }
    }
    if (execution) {
      try { await execution.tick(); }
      catch (error) { errors.push(`Execution: ${error instanceof Error ? error.message : String(error)}`); }
    }
    lastPollAt = Date.now();
    lastPollError = errors.length ? errors.join("; ") : null;
    if (errors.length) app.log.error({ errors }, "one or more scanner feeds failed");
  } catch (error) {
    lastPollError = error instanceof Error ? error.message : String(error);
    app.log.error({ err: error }, "scanner poll failed");
  } finally { polling = false; }
}

const executionMode = () => !liveSolana ? "read_only" :
  ["solana", liveBsc && "bsc", liveRh && "rh", "live"].filter(Boolean).join("_");
app.get("/health", async () => ({ ok: true, mode: executionMode(), evmScanners: scanners.length,
  solanaScanner: Boolean(solana), solanaClaims: Boolean(solanaClaims),
  solanaAutoDelivery: Boolean(solanaDistributor), lastPayoutError, lastFeeCollectionError,
  bscClaims: Boolean(bscClaims), rhClaims: Boolean(rhClaims), gmgnRhDiscovery: Boolean(gmgnRh),
  lastPollAt, lastPollError }));
app.get("/api/candidates", async () => ({ items: store.listCandidates(), filters: store.getFilters(),
  liveTrading: liveSolana, liveBscTrading: liveBsc, liveRhTrading: liveRh }));
app.get("/api/rounds", async () => {
  const items = store.listRounds();
  return { items, claimsEnabled: items.some((round) => {
    const chain = store.getCandidate(round.candidateId)?.candidate.chain;
    return Boolean(store.getPublishedRound(round.candidateId)) &&
      (chain === "sol" ? Boolean(solanaClaims) : chain === "bsc" ? Boolean(bscClaims) : Boolean(rhClaims));
  }) };
});
app.get("/api/stats", async (_request, reply) => {
  reply.header("cache-control", "no-store");
  const totals = store.purchaseTotals();
  const emptyQuotes: SpotQuotes = { sol: null, bsc: null, robinhood: null };
  return buildStatsSummary(totals, totals.count > 0 ? await cachedSpotQuotes() : emptyQuotes);
});
app.get<{ Querystring: { cursor?: string } }>("/api/stats/purchases", async (request, reply) => {
  reply.header("cache-control", "no-store");
  const parsed = z.object({ cursor: z.string().max(400).optional() }).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_cursor" });
  try {
    const page = store.purchasePage(10, parsed.data.cursor);
    return { ...page, items: page.items.map((item) => {
      tokenImages.enqueue(item.imageUrl);
      return { ...item, imageUrl: tokenImages.publicUrl(item.imageUrl) };
    }) };
  }
  catch { return reply.code(400).send({ error: "invalid_cursor" }); }
});
app.get<{ Querystring: { cursor?: string } }>("/api/stats/payouts", async (request, reply) => {
  reply.header("cache-control", "no-store");
  const parsed = z.object({ cursor: z.string().regex(/^[1-9]\d*$/).optional() }).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_cursor" });
  try { return store.solanaPayoutBatchPage(10, parsed.data.cursor === undefined ? undefined : Number(parsed.data.cursor)); }
  catch { return reply.code(400).send({ error: "invalid_cursor" }); }
});
app.get<{ Params: { file: string } }>("/token-images/:file", async (request, reply) => {
  const image = tokenImages.file(request.params.file);
  if (!image) return reply.code(404).send({ error: "image_not_cached" });
  reply.header("cache-control", "public, max-age=31536000, immutable");
  return reply.type(image.mime).send(image.stream);
});
app.get<{ Params: { chain: string; token: string } }>("/api/token-metadata/:chain/:token", async (request, reply) => {
  const parsed = z.object({ chain: z.enum(["sol", "bsc", "robinhood"]), token: z.string().min(1).max(64) })
    .safeParse(request.params);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_token" });
  const { chain, token } = parsed.data;
  if (!store.hasCandidate(chain, token)) return reply.code(404).send({ error: "unknown_token" });
  const row = store.listCandidates(10_000).find((item) => item.candidate.chain === chain &&
    item.candidate.token.toLowerCase() === token.toLowerCase());
  if (!row || !readyForMetadata(row, store.getFilters(), Date.now(), store.getTokenMetadata(chain, token),
      store.getExecutionStartAt()))
    return reply.code(404).send({ error: "token_not_qualified" });
  const metadata = await getOrFetchTokenMetadata(store, chain, token);
  tokenImages.enqueue(metadata.imageUrl);
  return publicMetadata(metadata);
});
app.get("/api/activity", async (_request, reply) => {
  reply.header("cache-control", "no-store");
  const rounds = new Map(store.listRounds(1000).map((round) => [round.candidateId, round]));
  const filters = store.getFilters();
  const now = Date.now();
  const feedStartAt = store.getExecutionStartAt();
  const visible = store.listCandidates(10_000).filter((row) =>
    readyForActivity(row, filters, store.getTokenMetadata(row.candidate.chain, row.candidate.token),
      now, feedStartAt)).slice(0, 30);
  return { mode: executionMode(), items: visible.map((row) => {
    const job = store.getJob(row.id);
    const round = rounds.get(row.id);
    const metadata = store.getTokenMetadata(row.candidate.chain, row.candidate.token);
    tokenImages.enqueue(metadata?.imageUrl);
    const visibleMetadata = metadata ? publicMetadata(metadata) : null;
    return { id: row.id, chain: row.candidate.chain, launchpad: row.candidate.launchpad,
      token: row.candidate.token, state: row.state, reasons: row.reasons, observedAt: row.observedAt,
      name: visibleMetadata?.name ?? null, symbol: visibleMetadata?.symbol ?? null,
      imageUrl: visibleMetadata?.imageUrl ?? null, metadataExpiresAt: visibleMetadata?.expiresAt ?? null,
      graduatedAt: row.candidate.graduatedAt, totalFeesNative: row.candidate.totalFeesNative,
      totalFeesUsd: row.candidate.totalFeesUsd, feeMetricsAt: row.candidate.feeMetricsAt,
      budgetLamports: typeof job?.data.budgetLamports === "string" ? job.data.budgetLamports : null,
      spendAtoms: typeof job?.data.spendAtoms === "string" ? job.data.spendAtoms : null,
      purchasedAtoms: typeof job?.data.purchasedAtoms === "string" ? job.data.purchasedAtoms : null,
      rewardDecimals: typeof job?.data.rewardDecimals === "number" ? job.data.rewardDecimals : null,
      purchaseTx: round?.purchaseTx ?? null };
  }) };
});
app.get<{ Params: { solWallet: string } }>("/api/rewards/:solWallet", async (request, reply) => {
  try { const wallet = new PublicKey(request.params.solWallet).toBase58();
    if (solanaClaims) await solanaClaims.reconcileWallet(wallet);
    return { items: store.rewardsForWallet(wallet).map((reward) => {
      const published = store.getPublishedRound(reward.candidateId);
      const payout = reward.chain === "sol" && published?.deliveryMode === "push"
        ? store.getSolanaPayout(reward.candidateId, wallet) : undefined;
      return { ...reward, deliveryMode: published?.deliveryMode ?? "claim",
      payoutState: payout?.state ?? null, payoutTx: payout?.signature ?? null,
      claimReady: ((Boolean(solanaClaims) && reward.chain === "sol" && published?.deliveryMode === "claim") ||
        (Boolean(bscClaims) && reward.chain === "bsc") ||
        (Boolean(rhClaims) && reward.chain === "robinhood")) &&
        Boolean(published?.claimTarget),
      claimed: payout ? payout.state === "sent" : reward.chain === "sol"
        ? store.getSolanaClaim(reward.candidateId, wallet)?.state === "claimed"
        : reward.chain === "bsc" ? bscClaims?.getClaim(reward.candidateId, wallet)?.claimed
        : rhClaims?.getClaim(reward.candidateId, wallet)?.claimed }; }),
      claimsEnabled: Boolean(solanaClaims || bscClaims || rhClaims) }; }
  catch { return reply.code(400).send({ error: "invalid_wallet" }); }
});
app.get<{ Params: { candidateId: string; solWallet: string } }>("/api/claims/:candidateId/:solWallet", async (request, reply) => {
  try {
    const proof = claimProof(store, request.params.candidateId, request.params.solWallet);
    return proof ?? reply.code(404).send({ error: "claim_not_ready" });
  } catch (error) {
    app.log.error({ err: error }, "claim manifest validation failed");
    return reply.code(503).send({ error: "claim_manifest_invalid" });
  }
});
app.post("/api/claims/solana/prepare", async (request, reply) => {
  const parsed = z.object({ candidateId: z.string(), solWallet: z.string() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_claim_request" });
  if (!solanaClaims) return reply.code(503).send({ error: "solana_claims_unavailable" });
  try { return await solanaClaims.prepare(parsed.data.candidateId, parsed.data.solWallet); }
  catch (error) { app.log.error({ err: error }, "Solana claim preparation failed");
    return reply.code(503).send({ error: "solana_claim_unavailable" }); }
});
app.post("/api/claims/solana/finalize", async (request, reply) => {
  const parsed = z.object({ candidateId: z.string(), solWallet: z.string(), signature: z.string() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_claim_request" });
  if (!solanaClaims) return reply.code(503).send({ error: "solana_claims_unavailable" });
  try { return await solanaClaims.finalize(parsed.data.candidateId, parsed.data.solWallet, parsed.data.signature); }
  catch (error) { app.log.error({ err: error }, "Solana claim finalization failed");
    return reply.code(503).send({ error: "solana_claim_not_confirmed" }); }
});
app.post("/api/claims/bsc/prepare", async (request, reply) => {
  const parsed = z.object({ candidateId: z.string(), solWallet: z.string() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_claim_request" });
  if (!bscClaims) return reply.code(503).send({ error: "bsc_claims_unavailable" });
  try { return await bscClaims.prepare(parsed.data.candidateId,
    new PublicKey(parsed.data.solWallet).toBase58()); }
  catch (error) { app.log.error({ err: error }, "BNB claim preparation failed");
    return reply.code(503).send({ error: "bsc_claim_unavailable" }); }
});
app.post("/api/claims/bsc/finalize", async (request, reply) => {
  const parsed = z.object({ candidateId: z.string(), solWallet: z.string(),
    reimbursementHash: z.string().regex(/^0x[\da-fA-F]{64}$/) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_claim_request" });
  if (!bscClaims) return reply.code(503).send({ error: "bsc_claims_unavailable" });
  try { return await bscClaims.finalize(parsed.data.candidateId,
    new PublicKey(parsed.data.solWallet).toBase58(), parsed.data.reimbursementHash as `0x${string}`); }
  catch (error) { app.log.error({ err: error }, "BNB claim finalization failed");
    return reply.code(503).send({ error: "bsc_claim_not_confirmed" }); }
});
app.post("/api/claims/rh/prepare", async (request, reply) => {
  const parsed = z.object({ candidateId: z.string(), solWallet: z.string() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_claim_request" });
  if (!rhClaims) return reply.code(503).send({ error: "rh_claims_unavailable" });
  try { return await rhClaims.prepare(parsed.data.candidateId,
    new PublicKey(parsed.data.solWallet).toBase58()); }
  catch (error) { app.log.error({ err: error }, "RH claim preparation failed");
    return reply.code(503).send({ error: "rh_claim_unavailable" }); }
});
app.post("/api/claims/rh/finalize", async (request, reply) => {
  const parsed = z.object({ candidateId: z.string(), solWallet: z.string(),
    reimbursementHash: z.string().regex(/^0x[\da-fA-F]{64}$/) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_claim_request" });
  if (!rhClaims) return reply.code(503).send({ error: "rh_claims_unavailable" });
  try { return await rhClaims.finalize(parsed.data.candidateId,
    new PublicKey(parsed.data.solWallet).toBase58(), parsed.data.reimbursementHash as `0x${string}`); }
  catch (error) { app.log.error({ err: error }, "RH claim finalization failed");
    return reply.code(503).send({ error: "rh_claim_not_confirmed" }); }
});
app.post("/api/link/challenge", async (request, reply) => {
  const parsed = z.object({ solWallet: z.string(), evmWallet: z.string() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_wallets" });
  try { return createWalletLinkChallenge(store, parsed.data.solWallet, parsed.data.evmWallet,
    process.env.PUBLIC_ORIGIN ?? "http://127.0.0.1:8789"); }
  catch { return reply.code(400).send({ error: "invalid_wallets" }); }
});
app.post("/api/link/confirm", async (request, reply) => {
  const parsed = z.object({ id: z.string(), solSignatureBase64: z.string(), evmSignature: z.string() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_link_proof" });
  try { return await confirmWalletLink(store, parsed.data.id, parsed.data.solSignatureBase64,
    parsed.data.evmSignature as `0x${string}`); }
  catch { return reply.code(400).send({ error: "invalid_link_proof" }); }
});
app.get<{ Params: { solWallet: string } }>("/api/link/:solWallet", async (request, reply) => {
  try { const wallet = new PublicKey(request.params.solWallet).toBase58();
    return { linked: store.getWalletLink(wallet)?.evmWallet ?? null }; }
  catch { return reply.code(400).send({ error: "invalid_wallet" }); }
});

const webRoot = resolve("web-dist");
if (existsSync(webRoot)) void app.register(staticPlugin, { root: webRoot, prefix: "/" });

let timer: ReturnType<typeof setInterval> | undefined;
let payoutTimer: ReturnType<typeof setInterval> | undefined;
function startBackgroundWork(): void {
  timer = setInterval(() => { void poll(); }, 5_000);
  timer.unref();
  payoutTimer = setInterval(() => {
    if (solanaDistributor) void solanaDistributor.tick().then(() => { lastPayoutError = null; })
      .catch((error: unknown) => {
        lastPayoutError = error instanceof Error ? error.message : String(error);
        app.log.error({ err: error }, "Solana automatic payout failed");
      });
  }, 2_000);
  payoutTimer.unref();
  void poll();
}
app.addHook("onClose", async () => {
  if (timer) clearInterval(timer);
  if (payoutTimer) clearInterval(payoutTimer);
  await solana?.stop(); store.close(); });

try {
  await solanaAdapter?.assertReady();
  await bscAdapter?.assertReady();
  await rhAdapter?.assertReady();
  if (solanaAdapter) {
    const evmAdapter = (chain: "bsc" | "robinhood") => {
      const adapter = chain === "bsc" ? bscAdapter : rhAdapter;
      if (!adapter) throw new Error(`${chain} execution adapter is unavailable`);
      return adapter;
    };
    const adapter: ExecutionAdapter = bscAdapter || rhAdapter ? {
      collectCreatorFees: (id) => solanaAdapter.collectCreatorFees(id),
      convertPumpToSol: (id) => solanaAdapter.convertPumpToSol(id),
      availableSolLamports: () => solanaAdapter.availableSolLamports(),
      bridge: (id, candidate, amount) => evmAdapter(candidate.chain as "bsc" | "robinhood")
        .bridge(id, candidate, amount),
      snapshot: () => solanaAdapter.snapshot(),
      buy: (id, candidate, amount) => candidate.chain === "sol"
        ? solanaAdapter.buy(id, candidate, amount)
        : evmAdapter(candidate.chain).buy(id, candidate, amount),
      fund: (id, candidate, purchase, holder, owner) => candidate.chain === "sol"
        ? solanaAdapter.fund(id, candidate, purchase, holder, owner)
        : evmAdapter(candidate.chain).fund(id, candidate, purchase, holder, owner),
      publish: (id, candidate, roundId, allocations, funded) => candidate.chain === "sol"
        ? solanaAdapter.publish(id, candidate, roundId, allocations, funded)
        : evmAdapter(candidate.chain).publish(id, candidate, roundId, allocations, funded),
    } : solanaAdapter;
    execution = new ExecutionEngine(store, adapter,
      { activatedAt: Date.now(), chains: ["sol", ...(bscAdapter ? ["bsc" as const] : []),
        ...(rhAdapter ? ["robinhood" as const] : [])], excludedSolanaMint: process.env.MAIN_TOKEN_MINT });
  }
  classify();
  await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT ?? 8789) });
  startBackgroundWork();
} catch (error) {
  app.log.error({ err: error }, "server failed");
  await app.close();
  process.exitCode = 1;
}
