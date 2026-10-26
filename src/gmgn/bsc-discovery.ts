import { randomUUID } from "node:crypto";
import { createPublicClient, http, isAddress } from "viem";
import { bsc } from "viem/chains";
import { EvmGraduationScanner } from "../evm/scanner.js";
import { Store } from "../store.js";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);

/** GMGN is a discovery hint. Flap/Four identities and migration transactions are checked on-chain. */
export class GmgnBscDiscovery {
  private nextPollAt = 0;
  private readonly client;

  constructor(private readonly store: Store, private readonly apiKey: string, rpcUrl: string,
    private readonly flap: EvmGraduationScanner, private readonly four: EvmGraduationScanner,
    private readonly request: typeof fetch = fetch) {
    this.client = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  }

  async poll(now = Date.now()): Promise<number> {
    if (now < this.nextPollAt) return 0;
    this.nextPollAt = now + 15_000;
    const query = new URLSearchParams({ chain: "bsc", timestamp: String(Math.floor(now / 1000)),
      client_id: randomUUID() });
    // GMGN currently returns both platforms from this unfiltered completed feed. Filtering
    // by a guessed Four.meme platform string can silently return no candidates.
    const response = await this.request(`https://openapi.gmgn.ai/v1/trenches?${query}`, {
      method: "POST", headers: { "content-type": "application/json", "X-APIKEY": this.apiKey },
      body: JSON.stringify({ version: "v2", completed: { limit: 80 } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      this.nextPollAt = Number.isFinite(reset) && reset > now / 1000 ? reset * 1000 + 30_000 : now + 60_000;
    }
    if (!response.ok) throw new Error(`GMGN BNB trenches HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const data = record(payload) && record(payload.data) ? payload.data : undefined;
    const rows = data && Array.isArray(data.completed) ? data.completed.filter(record) : [];
    const hints = { flap: new Set<string>(), fourmeme: new Set<string>() };
    const fees = new Map<string, number>();
    for (const row of rows) {
      const token = row.address;
      const platform = row.launchpad_platform;
      const seconds = Number(row.complete_timestamp);
      if (typeof token !== "string" || !isAddress(token) || typeof platform !== "string" ||
          !Number.isFinite(seconds) || seconds <= 0 || now - seconds * 1000 > 15 * 60_000 ||
          seconds * 1000 > now + 30_000) continue;
      const normalized = token.toLowerCase();
      if (this.store.hasCandidate("bsc", normalized)) continue;
      if (platform.toLowerCase() === "flap") hints.flap.add(normalized);
      if (platform.toLowerCase() === "fourmeme") hints.fourmeme.add(normalized);
      const total = Number(row.total_fee);
      if (Number.isFinite(total) && total >= 0) fees.set(normalized, total);
    }
    if (!hints.flap.size && !hints.fourmeme.size) return 0;
    const tip = await this.client.getBlockNumber();
    const safeTip = tip - 3n;
    // BSC can produce ~2,000 blocks in 15 minutes; allow room for GMGN indexing lag.
    const first = safeTip > 2400n ? safeTip - 2400n : 0n;
    let added = 0;
    for (let from = first; from <= safeTip; from += 300n) {
      const to = from + 299n < safeTip ? from + 299n : safeTip;
      if (hints.flap.size) added += await this.flap.scanHinted(from, to, hints.flap);
      if (hints.fourmeme.size) added += await this.four.scanHinted(from, to, hints.fourmeme);
    }
    for (const [token, totalFeesNative] of fees) {
      if (this.store.hasCandidate("bsc", token))
        this.store.enrichCandidate("bsc", token, { totalFeesNative, feeMetricsAt: now });
    }
    return added;
  }
}
