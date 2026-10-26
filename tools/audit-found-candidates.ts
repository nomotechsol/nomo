import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readyForActivity } from "../src/activity.js";
import { Store } from "../src/store.js";

type Check = { code: number | null; output: string; elapsedMs: number; timedOut: boolean };
const timeoutMs = 45_000;
const reportPath = resolve("reports/found-candidates-local-audit.json");
const store = new Store(process.env.DATABASE_PATH ?? "./data/nomo.db");
const filters = store.getFilters();
const all = store.listCandidates(10_000);
const feed = all.filter((row) => readyForActivity(row, filters,
  store.getTokenMetadata(row.candidate.chain, row.candidate.token)));
const selected = [...feed];
for (const row of all) {
  if (row.candidate.chain !== "sol" && !selected.some((item) => item.id === row.id)) selected.push(row);
}
store.close();

const report = {
  startedAt: new Date().toISOString(), finishedAt: null as string | null,
  method: "Solana on-chain route quotes; BNB/RH execution quotes plus eth_call. No mainnet sends.",
  input: { discovered: all.length, currentlyEligible: all.filter((row) => row.state === "eligible").length,
    inFeed: feed.length, extraEvm: selected.length - feed.length, tested: selected.length,
    filteredOrAwaitingData: all.length - selected.length },
  checks: selected.map((row) => ({ chain: row.candidate.chain, launchpad: row.candidate.launchpad,
    token: row.candidate.token, quoteAsset: row.candidate.quoteMint ?? row.candidate.quoteToken ?? null,
    candidateStateAtStart: row.state, qualificationAtStart: row.state === "eligible"
      ? "eligible_now" : feed.some((item) => item.id === row.id) ? "feed_history" : "other_verified_evm",
    status: "pending", check: null as Check | null })),
};
mkdirSync(resolve("reports"), { recursive: true });
const save = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
save();

function run(script: string, token: string, amount?: string): Promise<Check> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("npx", ["tsx", script, token, ...(amount ? [amount] : [])],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      output = output.replace(/https?:\/\/[^\s"']+/g, "[rpc]").slice(-1800);
      done({ code, output: output.trim(), elapsedMs: Date.now() - started, timedOut });
    };
    const collect = (chunk: Buffer) => { output += chunk.toString(); if (output.length > 4000) output = output.slice(-4000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", finish);
  });
}

let cursor = 0;
async function worker(): Promise<void> {
  while (true) {
    const index = cursor++;
    if (index >= selected.length) return;
    const candidate = selected[index]!.candidate;
    const script = candidate.chain === "sol" ? "tools/route-plan-smoke.ts" :
      candidate.chain === "bsc" ? "tools/bsc-route-smoke.ts" : "tools/rh-route-smoke.ts";
    const check = await run(script, candidate.token, candidate.chain === "sol" ? undefined : "0.01");
    const row = report.checks[index]!;
    row.status = check.timedOut ? "timeout" : check.code === 0 ?
      candidate.chain === "sol" ? "route_quote_succeeded" : "eth_call_succeeded" : "failed";
    row.check = check;
    save();
    process.stdout.write(`${index + 1}/${selected.length} ${candidate.chain} ${candidate.launchpad} ${candidate.token} ${row.status} ${check.elapsedMs}ms\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(4, selected.length) }, () => worker()));
report.finishedAt = new Date().toISOString();
save();
process.stdout.write(`Saved ${reportPath}\n`);
