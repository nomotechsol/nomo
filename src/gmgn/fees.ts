import { randomUUID } from "node:crypto";
import { type Candidate, type Chain } from "../domain.js";
import { Store } from "../store.js";

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const metric = (row: RecordValue, key: string): number | undefined => {
  const value = row[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
/** Verifies each on-chain graduation against GMGN's per-token fee metric. */
export class GmgnFeeEnricher {
  private nextPollAt = 0;
  private readonly nextDirectAt = new Map<string, number>();

  constructor(private readonly store: Store, private readonly apiKey: string,
    private readonly request: typeof fetch = fetch) {}

  async poll(now = Date.now()): Promise<void> {
    if (now < this.nextPollAt) return;
    this.nextPollAt = now + 5_000;
    const filters = this.store.getFilters();
    const pending = this.store.listCandidates(10_000).filter(({ candidate, state }) =>
      state !== "settled" && filters[candidate.launchpad]?.enabled &&
      !(candidate.launchpad === "pumpfun" && candidate.isMayhemMode === true) &&
      candidate.graduatedAt <= now && now - candidate.graduatedAt <= 30 * 60_000 &&
      (candidate.feeMetricsAt === undefined || now - candidate.feeMetricsAt >= 60_000) &&
      (this.nextDirectAt.get(`${candidate.chain}:${candidate.token}`) ?? 0) <= now).slice(0, 10);
    for (const [index, entry] of pending.entries()) {
      if (index) await new Promise((resolve) => setTimeout(resolve, 250));
      const candidate = entry.candidate;
      this.nextDirectAt.set(`${candidate.chain}:${candidate.token}`, now + 60_000);
      const info = await this.tokenInfo(candidate.chain, candidate.token);
      if (!info || !this.platformMatches(candidate, info) || metric(info, "total_fee") === undefined) continue;
      const migratedPool = typeof info.migrated_pool === "string" ? info.migrated_pool : undefined;
      // Pump.fun stores the migrated PumpSwap pool. StonkFun stores its verified LaunchLab
      // origin pool, while GMGN reports the different post-migration Raydium CPMM pool.
      if (candidate.launchpad === "pumpfun" && migratedPool && migratedPool !== candidate.pool) continue;
      if (candidate.chain === "robinhood") {
        const pool = isRecord(info.pool) ? info.pool : undefined;
        if (!pool || typeof pool.pool_address !== "string" ||
            pool.pool_address.toLowerCase() !== candidate.pool.toLowerCase() ||
            typeof pool.quote_address !== "string" ||
            pool.quote_address.toLowerCase() !== candidate.quoteToken?.toLowerCase()) continue;
      }
      this.enrich(candidate, info, now);
    }
  }

  private enrich(candidate: Candidate, row: RecordValue, now: number): void {
    const totalFeesNative = metric(row, "total_fee");
    if (totalFeesNative === undefined) return;
    const metrics: Partial<Candidate> = {
      totalFeesNative, feeMetricsAt: now,
      holders: metric(row, "holder_count"), marketCapUsd: metric(row, "usd_market_cap"),
      liquidityUsd: metric(row, "liquidity"), volumeUsd1h: metric(row, "volume_1h"),
    };
    this.store.enrichCandidate(candidate.chain, candidate.token, metrics);
  }

  private platformMatches(candidate: Candidate, row: RecordValue): boolean {
    const platform = typeof row.launchpad_platform === "string" ? row.launchpad_platform.toLowerCase() : "";
    if (candidate.launchpad === "pumpfun") return platform === "pump.fun";
    if (candidate.launchpad === "stonkfun") return platform.includes("ray") || platform.includes("stonk");
    if (candidate.launchpad === "fourmeme") return platform.includes("four");
    if (candidate.launchpad.startsWith("flap")) return platform.includes("flap");
    return candidate.launchpad === "pons_v2" && platform.includes("pons");
  }

  private async tokenInfo(chain: Chain, token: string): Promise<RecordValue | null> {
    const params = new URLSearchParams({ chain, address: token,
      timestamp: String(Math.floor(Date.now() / 1000)), client_id: randomUUID() });
    const response = await this.request(`https://openapi.gmgn.ai/v1/token/info?${params}`, {
      headers: { "X-APIKEY": this.apiKey }, signal: AbortSignal.timeout(10_000),
    });
    this.checkRateLimit(response);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${chain} token info HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const data = isRecord(payload) ? payload.data : undefined;
    if (!isRecord(data) || typeof data.address !== "string" ||
        (chain === "sol" ? data.address !== token : data.address.toLowerCase() !== token.toLowerCase())) return null;
    return data;
  }

  private checkRateLimit(response: Response): void {
    if (response.status !== 429) return;
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const until = Number.isFinite(reset) && reset > Date.now() / 1000
      ? reset * 1000 + 30_000 : Date.now() + 60_000;
    this.nextPollAt = Math.max(this.nextPollAt, until);
    throw new Error(`GMGN rate limited until ${new Date(until).toISOString()}`);
  }
}
