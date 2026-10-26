import type { Chain } from "./domain.js";
import type { PurchaseTotals } from "./store.js";

export type SpotQuote = { usd: number; source: "binance" | "coingecko"; fetchedAt: number };
export type SpotQuotes = Record<Chain, SpotQuote | null>;

const binanceSymbols: Record<Chain, string> = { sol: "SOLUSDT", bsc: "BNBUSDT", robinhood: "ETHUSDT" };
const coingeckoIds: Record<Chain, string> = { sol: "solana", bsc: "binancecoin", robinhood: "ethereum" };
let cached: { quotes: SpotQuotes; expiresAt: number } | null = null;
let inflight: Promise<SpotQuotes> | null = null;

function positivePrice(value: unknown): number | null {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Binance USDT spot quotes are treated as approximate USD; CoinGecko USD is a fallback. */
export async function fetchSpotQuotes(fetcher: typeof fetch = fetch): Promise<SpotQuotes> {
  const now = Date.now();
  const quotes: SpotQuotes = { sol: null, bsc: null, robinhood: null };
  try {
    const symbols = Object.values(binanceSymbols);
    const url = `https://data-api.binance.vision/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
    const response = await fetcher(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Binance prices: ${response.status}`);
    const data = await response.json() as Array<{ symbol?: string; price?: string }>;
    if (Array.isArray(data)) for (const chain of Object.keys(binanceSymbols) as Chain[]) {
      const price = positivePrice(data.find((row) => row.symbol === binanceSymbols[chain])?.price);
      if (price !== null) quotes[chain] = { usd: price, source: "binance", fetchedAt: now };
    }
  } catch { /* public endpoint may be temporarily unavailable or region-limited */ }
  if (Object.values(quotes).some((quote) => quote === null)) {
    try {
      const url = "https://api.coingecko.com/api/v3/simple/price?ids=solana%2Cbinancecoin%2Cethereum&vs_currencies=usd";
      const response = await fetcher(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`CoinGecko prices: ${response.status}`);
      const data = await response.json() as Record<string, { usd?: number }>;
      for (const chain of Object.keys(coingeckoIds) as Chain[]) {
        if (quotes[chain]) continue;
        const price = positivePrice(data[coingeckoIds[chain]]?.usd);
        if (price !== null) quotes[chain] = { usd: price, source: "coingecko", fetchedAt: now };
      }
    } catch { /* unavailable USD values remain null */ }
  }
  return quotes;
}

export async function cachedSpotQuotes(): Promise<SpotQuotes> {
  if (cached && cached.expiresAt > Date.now()) return cached.quotes;
  if (inflight) return inflight;
  inflight = fetchSpotQuotes();
  try {
    const quotes = await inflight;
    cached = { quotes, expiresAt: Date.now() + (Object.values(quotes).every(Boolean) ? 60_000 : 30_000) };
    return quotes;
  } finally { inflight = null; }
}

export function buildStatsSummary(totals: PurchaseTotals, quotes: SpotQuotes) {
  const chains = {} as Record<Chain, { count: number; nativeUnit: "SOL" | "BNB" | "ETH";
    spendAtoms: string | null; usd: number | null; price: SpotQuote | null }>;
  for (const chain of ["sol", "bsc", "robinhood"] as const) {
    const total = totals.chains[chain];
    const price = quotes[chain];
    const decimals = chain === "sol" ? 9 : 18;
    const estimatedUsd = total.count === 0 ? 0 : total.spendAtoms !== null && price
      ? Number(BigInt(total.spendAtoms)) / 10 ** decimals * price.usd : null;
    const usd = estimatedUsd !== null && Number.isFinite(estimatedUsd) ? estimatedUsd : null;
    chains[chain] = { count: total.count, nativeUnit: chain === "sol" ? "SOL" : chain === "bsc" ? "BNB" : "ETH",
      spendAtoms: total.spendAtoms, usd, price };
  }
  const usdValues = Object.values(chains).map((row) => row.usd);
  return { count: totals.count, solBudgetLamports: totals.solBudgetLamports, chains,
    totalUsd: usdValues.every((value) => value !== null) ? usdValues.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null,
    valuation: "current_spot_estimate" as const };
}
