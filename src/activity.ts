import { evaluateCandidate, missingCandidateData, type FilterSet } from "./domain.js";
import type { CandidateRow, TokenMetadata } from "./store.js";

/** A public feed entry must have passed the current rules and have displayable metadata. */
export function readyForActivity(row: CandidateRow, filters: FilterSet, metadata: TokenMetadata | null,
  now = Date.now()): boolean {
  const historicalQualified = row.state === "rejected" && row.reasons.length > 0 &&
    row.reasons.every((reason) => reason === "fee_metrics_stale" || reason === "graduation_age_outside_range");
  if (row.state !== "eligible" && row.state !== "reserved" && row.state !== "settled" &&
      !historicalQualified) return false;
  if (!metadata?.name || !metadata.symbol) return false;
  if (row.state === "reserved" || row.state === "settled") return true;
  const rule = filters[row.candidate.launchpad];
  // Freshness limits protect new purchases; a previously verified token remains in feed history.
  const feedRule = rule && historicalQualified ? { ...rule, maxFeeMetricsAgeSeconds: undefined,
    maxGraduationAgeSeconds: undefined } : rule;
  if (!feedRule || evaluateCandidate(row.candidate, feedRule, now).length ||
      missingCandidateData(row.candidate, feedRule).length)
    return false;
  // The feed is specifically for candidates with confirmed GMGN Total Fees.
  return row.candidate.totalFeesNative !== undefined && row.candidate.feeMetricsAt !== undefined;
}

export function readyForMetadata(row: CandidateRow, filters: FilterSet, now = Date.now(),
  metadata: TokenMetadata | null = null): boolean {
  if (row.state === "rejected") return readyForActivity(row, filters, metadata, now);
  if (row.state !== "eligible" && row.state !== "reserved" && row.state !== "settled") return false;
  const rule = filters[row.candidate.launchpad];
  if (row.state === "eligible" && (!rule || evaluateCandidate(row.candidate, rule, now).length ||
    missingCandidateData(row.candidate, rule).length)) return false;
  return row.candidate.totalFeesNative !== undefined && row.candidate.feeMetricsAt !== undefined;
}
