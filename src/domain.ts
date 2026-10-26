export type Chain = "sol" | "bsc" | "robinhood";
export type Launchpad = "pumpfun" | "stonkfun" | "fourmeme" | "flap_tax" | "flap_nontax" | "pons_v2";

export type Candidate = {
  chain: Chain;
  launchpad: Launchpad;
  token: string;
  pool: string;
  /** The pool's actual quote mint on Solana. A graduated token need not be paired with SOL. */
  quoteMint?: string;
  /** The pool's actual quote ERC-20 on EVM; native pairs use wrapped BNB/ETH. */
  quoteToken?: string;
  graduationTx: string;
  graduatedAt: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  volumeUsd1h?: number;
  top10Rate?: number;
  bundlerRate?: number;
  insiderRate?: number;
  isHoneypot?: boolean;
  /** Decoded from the PumpSwap pool itself; required before a Pump.fun token can qualify. */
  isMayhemMode?: boolean;
  taxBps?: number;
  /** GMGN Total Fees for THIS token, in SOL/BNB/ETH independent of the pool quote. Never NOMO creator fees. */
  totalFeesNative?: number;
  /** Optional derived USD estimate; not used by the default chain fee filters. */
  totalFeesUsd?: number;
  feeMetricsAt?: number;
};

export type FilterRule = {
  enabled: boolean;
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  minLiquidityUsd?: number;
  minHolders?: number;
  minVolumeUsd1h?: number;
  maxTop10Rate?: number;
  maxBundlerRate?: number;
  maxInsiderRate?: number;
  maxTaxBps?: number;
  requireNotHoneypot?: boolean;
  maxGraduationAgeSeconds?: number;
  minTotalFeesNative?: number;
  minTotalFeesUsd?: number;
  maxFeeMetricsAgeSeconds?: number;
};

export type FilterSet = Record<Launchpad, FilterRule>;

export const DEFAULT_MAX_GRADUATION_AGE_MS = 5 * 60_000;

export const disabledFilters: FilterSet = {
  pumpfun: { enabled: false },
  stonkfun: { enabled: false },
  fourmeme: { enabled: false },
  flap_tax: { enabled: false },
  flap_nontax: { enabled: false },
  pons_v2: { enabled: false },
};

export function candidateKey(candidate: Candidate): string {
  const token = candidate.chain === "sol" ? candidate.token : candidate.token.toLowerCase();
  const transaction = candidate.chain === "sol" ? candidate.graduationTx : candidate.graduationTx.toLowerCase();
  return `${candidate.chain}:${candidate.launchpad}:${token}:${transaction}`;
}

export function evaluateCandidate(candidate: Candidate, rule: FilterRule, nowMs: number): string[] {
  const failures: string[] = [];
  if (!rule.enabled) return ["launchpad_disabled"];
  if (!candidate.token || !candidate.pool || !candidate.graduationTx) failures.push("missing_onchain_identity");
  if (candidate.launchpad === "pumpfun" && candidate.isMayhemMode === true) failures.push("mayhem_mode");
  const minimums: Array<[keyof Candidate, number | undefined, string]> = [
    ["marketCapUsd", rule.minMarketCapUsd, "market_cap_below_min"],
    ["liquidityUsd", rule.minLiquidityUsd, "liquidity_below_min"],
    ["holders", rule.minHolders, "holders_below_min"],
    ["volumeUsd1h", rule.minVolumeUsd1h, "volume_below_min"],
    ["totalFeesNative", rule.minTotalFeesNative, "total_fees_native_below_min"],
    ["totalFeesUsd", rule.minTotalFeesUsd, "total_fees_usd_below_min"],
  ];
  for (const [field, limit, reason] of minimums) {
    if (limit !== undefined && (typeof candidate[field] !== "number" || candidate[field] < limit)) failures.push(reason);
  }
  const maximums: Array<[keyof Candidate, number | undefined, string]> = [
    ["marketCapUsd", rule.maxMarketCapUsd, "market_cap_above_max"],
    ["top10Rate", rule.maxTop10Rate, "top10_above_max"],
    ["bundlerRate", rule.maxBundlerRate, "bundler_above_max"],
    ["insiderRate", rule.maxInsiderRate, "insider_above_max"],
    ["taxBps", rule.maxTaxBps, "tax_above_max"],
  ];
  for (const [field, limit, reason] of maximums) {
    if (limit !== undefined && (typeof candidate[field] !== "number" || candidate[field] > limit)) failures.push(reason);
  }
  if (rule.requireNotHoneypot && candidate.isHoneypot !== false) failures.push("honeypot_not_cleared");
  if (rule.maxFeeMetricsAgeSeconds !== undefined &&
      (candidate.feeMetricsAt === undefined || nowMs - candidate.feeMetricsAt > rule.maxFeeMetricsAgeSeconds * 1000 ||
       candidate.feeMetricsAt > nowMs)) failures.push("fee_metrics_stale");
  if (rule.maxGraduationAgeSeconds !== undefined &&
      (candidate.graduatedAt <= 0 || nowMs - candidate.graduatedAt > rule.maxGraduationAgeSeconds * 1000 || candidate.graduatedAt > nowMs)) {
    failures.push("graduation_age_outside_range");
  }
  return failures;
}

export function missingCandidateData(candidate: Candidate, rule: FilterRule): string[] {
  if (!rule.enabled) return [];
  const missing: string[] = [];
  if (!candidate.token || !candidate.pool || !candidate.graduationTx) missing.push("onchain_identity");
  const fields: Array<[keyof Candidate, boolean]> = [
    ["marketCapUsd", rule.minMarketCapUsd !== undefined || rule.maxMarketCapUsd !== undefined],
    ["liquidityUsd", rule.minLiquidityUsd !== undefined],
    ["holders", rule.minHolders !== undefined],
    ["volumeUsd1h", rule.minVolumeUsd1h !== undefined],
    ["top10Rate", rule.maxTop10Rate !== undefined],
    ["bundlerRate", rule.maxBundlerRate !== undefined],
    ["insiderRate", rule.maxInsiderRate !== undefined],
    ["taxBps", rule.maxTaxBps !== undefined],
    ["isHoneypot", rule.requireNotHoneypot === true],
    ["isMayhemMode", candidate.launchpad === "pumpfun"],
    ["quoteMint", candidate.chain === "sol"],
    ["quoteToken", candidate.chain !== "sol"],
    ["totalFeesNative", rule.minTotalFeesNative !== undefined],
    ["totalFeesUsd", rule.minTotalFeesUsd !== undefined],
    ["feeMetricsAt", rule.maxFeeMetricsAgeSeconds !== undefined],
  ];
  for (const [field, required] of fields) if (required && candidate[field] === undefined) missing.push(field);
  return missing;
}

export function quarterOfCurrentBalance(balance: bigint, requiredFeeReserve: bigint): bigint {
  if (balance < 0n || requiredFeeReserve < 0n) throw new Error("Invalid balance or reserve");
  const budget = balance / 4n;
  if (budget === 0n || balance - budget < requiredFeeReserve) return 0n;
  return budget;
}

/** Split the tokens actually received from a buy: 70% for holders, 30% retained by the owner's chain wallet. */
export function splitBoughtTokens(receivedAtoms: bigint): { holderAtoms: bigint; ownerAtoms: bigint } {
  if (receivedAtoms <= 0n) throw new Error("Purchase produced no tokens");
  const holderAtoms = receivedAtoms * 70n / 100n;
  if (holderAtoms === 0n) throw new Error("Purchase is too small to distribute");
  return { holderAtoms, ownerAtoms: receivedAtoms - holderAtoms };
}

export type Holder = { solWallet: string; rawBalance: bigint };
export type Allocation = { solWallet: string; rewardAtoms: bigint };

export function allocateExactly(receivedAtoms: bigint, holders: Holder[]): Allocation[] {
  if (receivedAtoms < 0n || holders.length === 0) throw new Error("Invalid reward or no eligible holders");
  if (holders.some((holder) => holder.rawBalance <= 0n || !holder.solWallet)) throw new Error("Invalid holder");
  if (new Set(holders.map((holder) => holder.solWallet)).size !== holders.length) throw new Error("Duplicate holder");
  const denominator = holders.reduce((sum, holder) => sum + holder.rawBalance, 0n);
  const allocation = holders.map((holder) => ({
    solWallet: holder.solWallet,
    rewardAtoms: receivedAtoms * holder.rawBalance / denominator,
    remainder: receivedAtoms * holder.rawBalance % denominator,
  }));
  let dust = receivedAtoms - allocation.reduce((sum, row) => sum + row.rewardAtoms, 0n);
  allocation.sort((a, b) => a.remainder === b.remainder
    ? a.solWallet.localeCompare(b.solWallet)
    : a.remainder > b.remainder ? -1 : 1);
  for (const row of allocation) {
    if (dust === 0n) break;
    row.rewardAtoms++;
    dust--;
  }
  return allocation.sort((a, b) => a.solWallet.localeCompare(b.solWallet))
    .map(({ solWallet, rewardAtoms }) => ({ solWallet, rewardAtoms }));
}
