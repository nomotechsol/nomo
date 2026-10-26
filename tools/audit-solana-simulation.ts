import "dotenv/config";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const reportPath = resolve("reports/found-candidates-local-audit.json");
const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
  checks: Array<{ chain: string; launchpad: string; token: string; status: string;
    localSimulation?: { status: string; output: string; elapsedMs: number } }>;
  localSimulationFinishedAt?: string;
};
const indexes = report.checks.map((row, index) => ({ row, index }))
  .filter(({ row }) => row.chain === "sol" && row.status === "route_quote_succeeded");
let cursor = 0;
function run(token: string): Promise<{ status: string; output: string; elapsedMs: number }> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("npx", ["tsx", "tools/auto-buy-local-smoke.ts", token], {
      cwd: process.cwd(), env: { ...process.env, SIMULATION_ONLY: "1",
        LOCAL_SOLANA_RPC_URL: "http://127.0.0.1:8999" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const clean = output.replace(/https?:\/\/[^\s"']+/g, "[rpc]").slice(-900).trim();
      let step: string | undefined;
      if (code === 0) {
        try { step = (JSON.parse(clean) as { step?: string }).step; } catch { /* classify as failed */ }
      }
      done({ status: timedOut ? "timeout" : step === "purchase" ? "purchase_simulated" :
        step === "funding" ? "funding_simulated_only" : "failed",
      output: clean, elapsedMs: Date.now() - started });
    };
    const collect = (chunk: Buffer) => { output += chunk.toString(); if (output.length > 3000) output = output.slice(-3000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 35_000);
    child.on("error", () => finish(null));
    child.on("close", finish);
  });
}
async function worker(): Promise<void> {
  while (true) {
    const at = cursor++;
    if (at >= indexes.length) return;
    const { row, index } = indexes[at]!;
    const check = await run(row.token);
    report.checks[index]!.localSimulation = check;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${at + 1}/${indexes.length} ${row.launchpad} ${row.token} ${check.status} ${check.elapsedMs}ms\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(2, indexes.length) }, () => worker()));
report.localSimulationFinishedAt = new Date().toISOString();
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
