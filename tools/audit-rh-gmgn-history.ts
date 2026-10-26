import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createPublicClient, getAddress, http, parseEther } from "viem";
import type { Candidate } from "../src/domain.js";
import { PonsV4RouteUnavailableError, PonsV4Swap } from "../src/execution/pons-v4-swap.js";
import { RelayBscSwap } from "../src/execution/relay-bsc-swap.js";
import { robinhood } from "../src/evm/scanner.js";

type GmgnRow = { address?: string; launchpad_platform?: string; pool_address?: string;
  quote_address?: string; total_fee?: string | number; complete_timestamp?: number };
type Result = { token: string; quoteToken: string; pool: string; totalFeeEth: number;
  completedAt: string; aboveCurrentFeeThreshold: boolean; status: string;
  expectedOutAtoms?: string; minimumOutAtoms?: string; errorType?: string };

const apiKey = process.env.GMGN_API_KEY;
const rpcUrl = process.env.RH_RPC_URL;
if (!apiKey || !rpcUrl) throw new Error("GMGN_API_KEY and RH_RPC_URL are required");

const thresholdEth = 0.042934;
const spendEth = "0.01";
const amount = parseEther(spendEth);
const sender = "0x03508bb71268bba25ecacc8f620e01866650532c";
const query = new URLSearchParams({ chain: "robinhood",
  timestamp: String(Math.floor(Date.now() / 1000)), client_id: randomUUID() });
const response = await fetch(`https://openapi.gmgn.ai/v1/trenches?${query}`, {
  method: "POST", headers: { "content-type": "application/json", "X-APIKEY": apiKey },
  body: JSON.stringify({ version: "v2", completed: { filters: ["offchain", "onchain"],
    launchpad_platform_v2: true, limit: 80, launchpad_platform: ["pons_v2"] } }),
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`GMGN historical completed HTTP ${response.status}`);
const payload = await response.json() as { code?: number; data?: { completed?: GmgnRow[] } };
if (payload.code !== 0 || !Array.isArray(payload.data?.completed))
  throw new Error("GMGN historical completed response unavailable");
const rows = payload.data.completed;
const client = createPublicClient({ chain: robinhood, transport: http(rpcUrl) });
if (await client.getChainId() !== 4663) throw new Error("RH RPC chain mismatch");
const swap = new PonsV4Swap(rpcUrl);
const relay = new RelayBscSwap(fetch, "robinhood");
const results: Result[] = rows.map((row) => {
  const totalFeeEth = Number(row.total_fee);
  const valid = typeof row.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(row.address) &&
    typeof row.quote_address === "string" && /^0x[0-9a-fA-F]{40}$/.test(row.quote_address) &&
    typeof row.pool_address === "string" && /^0x[0-9a-fA-F]{64}$/.test(row.pool_address) &&
    row.launchpad_platform === "pons_v2" && Number.isFinite(totalFeeEth) && totalFeeEth >= 0 &&
    Number.isFinite(row.complete_timestamp) && Number(row.complete_timestamp) > 0;
  return { token: row.address ?? "", quoteToken: row.quote_address ?? "", pool: row.pool_address ?? "",
    totalFeeEth, completedAt: valid ? new Date(Number(row.complete_timestamp) * 1000).toISOString() : "",
    aboveCurrentFeeThreshold: valid && totalFeeEth >= thresholdEth,
    status: valid ? totalFeeEth >= thresholdEth ? "pending" : "below_fee_threshold" : "invalid_gmgn_row" };
});

let next = 0;
let completed = 0;
const worker = async () => {
  while (next < results.length) {
    const index = next++;
    const result = results[index]!;
    if (!result.aboveCurrentFeeThreshold) continue;
    const candidate: Candidate = { chain: "robinhood", launchpad: "pons_v2",
      token: getAddress(result.token), quoteToken: getAddress(result.quoteToken), pool: result.pool,
      graduationTx: "historical-gmgn-route-check", graduatedAt: Date.parse(result.completedAt),
      totalFeesNative: result.totalFeeEth };
    try {
      // quote() verifies the current Pons factory state, pair token and v4 pool ID.
      const quote = await swap.quote(candidate, amount, sender);
      await client.call({ account: sender, to: quote.to, data: quote.data, value: quote.value,
        gas: 2_000_000n, stateOverride: [{ address: sender, balance: amount * 2n + parseEther("1") }] });
      result.status = "eth_call_succeeded";
      result.expectedOutAtoms = quote.expectedOut.toString();
      result.minimumOutAtoms = quote.minimumOut.toString();
    } catch (error) {
      if (error instanceof PonsV4RouteUnavailableError) {
        try {
          const quote = await relay.quote(candidate, amount, sender);
          await client.call({ account: sender, to: quote.to, data: quote.data, value: quote.value,
            gas: 2_000_000n, stateOverride: [{ address: sender, balance: amount * 2n + parseEther("1") }] });
          result.status = "relay_eth_call_succeeded";
          result.expectedOutAtoms = quote.expectedOut.toString();
          result.minimumOutAtoms = quote.minimumOut.toString();
        } catch (fallbackError) {
          result.status = "simulation_failed";
          const status = fallbackError instanceof Error ? fallbackError.message.match(/HTTP (\d+)/)?.[1] : undefined;
          result.errorType = status ? `relay_http_${status}` : "relay_route_unavailable";
        }
      } else {
        result.status = "simulation_failed";
        result.errorType = error instanceof Error && error.message.includes("factory") ? "factory_or_pool_mismatch" :
          error instanceof Error && error.message.includes("eth_call") ? "eth_call_reverted" :
          error instanceof Error ? error.name : "unknown";
      }
    }
    completed++;
    if (completed % 10 === 0) process.stdout.write(`RH simulated ${completed} fee-qualified tokens\n`);
  }
};
await Promise.all(Array.from({ length: 4 }, worker));

const summary = { capturedAt: new Date().toISOString(), source: "GMGN Robinhood completed / pons_v2",
  displayedLimit: 80, returned: rows.length, feeThresholdEth: thresholdEth, testSpendEth: spendEth,
  note: "Current-state simulation only. GMGN historical Total Fees is current cumulative value, not its value at graduation.",
  counts: Object.fromEntries([...new Set(results.map((r) => r.status))].map((status) =>
    [status, results.filter((r) => r.status === status).length])), results };
writeFileSync("reports/rh-gmgn-history-simulation.json", JSON.stringify(summary, null, 2) + "\n");
const lines = ["# RH Pons V2: GMGN completed and purchase simulation", "",
  `Snapshot: ${summary.capturedAt}. GMGN returned ${rows.length} tokens; current threshold ${thresholdEth} ETH; simulated buy ${spendEth} ETH.`,
  "", ...Object.entries(summary.counts).map(([status, count]) => `- ${status}: ${count}`), "",
  "The `eth_call` check uses a test balance through state override and does not broadcast a transaction.",
  "This checks routes against the current pool state. GMGN does not return historical Total Fees at graduation here.",
  "", "| Token | Current GMGN Total Fees ETH | Pair | Result |", "| --- | ---: | --- | --- |",
  ...results.map((r) => `| ${r.token} | ${Number.isFinite(r.totalFeeEth) ? r.totalFeeEth.toFixed(6) : "?"} | ${r.quoteToken} | ${r.status}${r.errorType ? ` (${r.errorType})` : ""} |`), ""];
writeFileSync("reports/rh-gmgn-history-simulation.md", lines.join("\n"));
console.log(JSON.stringify({ returned: summary.returned, counts: summary.counts,
  report: "reports/rh-gmgn-history-simulation.md" }));
