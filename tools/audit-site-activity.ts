import "dotenv/config";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Check = { code: number | null; output: string; elapsedMs: number; timedOut: boolean };
type SiteItem = { id: string; chain: "sol" | "bsc" | "robinhood";
  launchpad: string; token: string; state: string; reasons: string[] };
const reportPath = resolve("reports/site-activity-live-snapshot.json");
const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
  capturedAt: string; items: SiteItem[]; checks: Array<Record<string, unknown>>;
  finishedAt?: string;
};
const save = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

function run(script: string, token: string, extra: string[] = [], env: Record<string, string> = {}): Promise<Check> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("npx", ["tsx", script, token, ...extra], { cwd: process.cwd(),
      env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ code, output: output.replace(/https?:\/\/[^\s"']+/g, "[rpc]").slice(-1200).trim(),
        elapsedMs: Date.now() - started, timedOut });
    };
    const collect = (chunk: Buffer) => { output += chunk.toString(); if (output.length > 3500) output = output.slice(-3500); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 45_000);
    child.on("error", () => finish(null));
    child.on("close", finish);
  });
}

let cursor = 0;
async function worker(): Promise<void> {
  while (true) {
    const index = cursor++;
    if (index >= report.items.length) return;
    const item = report.items[index]!;
    const checks: Record<string, Check> = {};
    let status = "failed";
    if (item.chain === "sol") {
      checks.route = await run("tools/route-plan-smoke.ts", item.token);
      if (checks.route.code === 0) {
        checks.firstTransaction = await run("tools/auto-buy-local-smoke.ts", item.token, [],
          { SIMULATION_ONLY: "1", LOCAL_SOLANA_RPC_URL: "http://127.0.0.1:8999" });
        if (checks.firstTransaction.code === 0) {
          let step: string | undefined;
          try { step = (JSON.parse(checks.firstTransaction.output) as { step?: string }).step; }
          catch { /* Invalid output is a failed check. */ }
          if (step === "purchase") status = "purchase_simulated";
          else if (step === "funding" && item.launchpad === "pumpfun") {
            checks.purchase = await run("tools/local-pump-funded-simulation.ts", item.token);
            if (checks.purchase.code === 0) status = "funding_and_purchase_simulated_separately";
          }
        }
      }
    } else {
      checks.ethCall = await run(item.chain === "bsc" ? "tools/bsc-route-smoke.ts" :
        "tools/rh-route-smoke.ts", item.token, ["0.01"]);
      if (checks.ethCall.code === 0) status = "eth_call_succeeded";
    }
    report.checks[index] = { id: item.id, chain: item.chain, launchpad: item.launchpad,
      token: item.token, stateAtSnapshot: item.state, reasonsAtSnapshot: item.reasons,
      status, checks };
    save();
    process.stdout.write(`${index + 1}/${report.items.length} ${item.chain} ${item.launchpad} ${item.token} ${status}\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(3, report.items.length) }, () => worker()));
report.finishedAt = new Date().toISOString();
save();
