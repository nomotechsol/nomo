import { randomUUID } from "node:crypto";
import { createPublicClient, http, isAddress, type PublicClient } from "viem";
import { EvmGraduationScanner, robinhood } from "../evm/scanner.js";
import { Store } from "../store.js";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);

/** GMGN supplies recent Pons addresses; only verified PoolGraduated logs create candidates. */
export class GmgnRhDiscovery {
  private nextPollAt = 0;
  private readonly client: PublicClient;

  constructor(private readonly store: Store, private readonly apiKey: string, rpcUrl: string,
    private readonly pons: EvmGraduationScanner, private readonly request: typeof fetch = fetch,
    client?: PublicClient) {
    this.client = client ?? createPublicClient({ chain: robinhood, transport: http(rpcUrl) });
  }

  async poll(now = Date.now()): Promise<number> {
    if (now < this.nextPollAt) return 0;
    this.nextPollAt = now + 15_000;
    const query = new URLSearchParams({ chain: "robinhood", timestamp: String(Math.floor(now / 1000)),
      client_id: randomUUID() });
    const response = await this.request(`https://openapi.gmgn.ai/v1/trenches?${query}`, {
      method: "POST", headers: { "content-type": "application/json", "X-APIKEY": this.apiKey },
      body: JSON.stringify({ version: "v2", completed: { filters: ["offchain", "onchain"],
        launchpad_platform_v2: true, limit: 80, launchpad_platform: ["pons_v2"] } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      this.nextPollAt = Number.isFinite(reset) && reset > now / 1000 ? reset * 1000 + 30_000 : now + 60_000;
    }
    if (!response.ok) throw new Error(`GMGN RH trenches HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!record(payload) || payload.code !== 0 || !record(payload.data) ||
        !Array.isArray(payload.data.completed)) throw new Error("GMGN RH completed response unavailable");
    const rows = payload.data.completed.filter(record);
    const hints = new Map<string, number>();
    for (const row of rows) {
      const token = row.address;
      const completedAt = Number(row.complete_timestamp) * 1000;
      if (typeof token !== "string" || !isAddress(token) || row.launchpad_platform !== "pons_v2" ||
          !Number.isFinite(completedAt) || completedAt <= 0 || now - completedAt > 15 * 60_000 ||
          completedAt > now + 30_000 || this.store.hasCandidate("robinhood", token)) continue;
      hints.set(token.toLowerCase(), completedAt);
    }
    if (!hints.size) return 0;
    if (await this.client.getChainId() !== robinhood.id) throw new Error("RH RPC chain mismatch");
    const tip = await this.client.getBlockNumber();
    if (tip < 3n) return 0;
    const safeTip = tip - 3n;
    const earliest = Math.min(...hints.values()) - 30_000;
    const latest = Math.max(...hints.values()) + 30_000;
    const first = await this.blockAtOrBefore(earliest, safeTip);
    const last = await this.blockAtOrBefore(latest, safeTip);
    let added = 0;
    for (let from = first; from <= last && hints.size; from += 2_000n) {
      const to = from + 1_999n < last ? from + 1_999n : last;
      added += await this.pons.scanHinted(from, to, new Set(hints.keys()));
      for (const token of hints.keys()) {
        if (this.store.hasCandidate("robinhood", token)) hints.delete(token);
      }
    }
    return added;
  }

  private async blockAtOrBefore(timestampMs: number, safeTip: bigint): Promise<bigint> {
    let span = 10_000n;
    let low = safeTip > span ? safeTip - span : 0n;
    let high = safeTip;
    while (low > 0n && Number((await this.client.getBlock({ blockNumber: low })).timestamp) * 1000 > timestampMs) {
      span *= 2n;
      low = safeTip > span ? safeTip - span : 0n;
    }
    if (Number((await this.client.getBlock({ blockNumber: high })).timestamp) * 1000 <= timestampMs)
      return high;
    while (high - low > 1n) {
      const mid = (low + high) / 2n;
      if (Number((await this.client.getBlock({ blockNumber: mid })).timestamp) * 1000 <= timestampMs) low = mid;
      else high = mid;
    }
    return low;
  }
}
