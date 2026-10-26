import "dotenv/config";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const reportPath = resolve("reports/found-candidates-local-audit.json");
const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
  checks: Array<{ chain: string; token: string; localSimulation?: { status: string };
    fundedPurchaseSimulation?: { status: string; output: string; elapsedMs: number } }>;
};
const retryFailed = process.argv.includes("--failed");
const selected = report.checks.filter((item) => item.chain === "sol" &&
  item.localSimulation?.status === "funding_simulated_only" &&
  (!retryFailed || item.fundedPurchaseSimulation?.status === "failed" ||
    item.fundedPurchaseSimulation?.status === "timeout"));
let cursor = 0;
function run(token: string): Promise<{ status: string; output: string; elapsedMs: number }> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("npx", ["tsx", "tools/local-pump-funded-simulation.ts", token], {
      cwd: process.cwd(), env: { ...process.env, LOCAL_SOLANA_RPC_URL: "http://127.0.0.1:8999" },
      stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const clean = output.replace(/https?:\/\/[^\s"']+/g, "[rpc]").slice(-900).trim();
      done({ status: timedOut ? "timeout" : code === 0 ? "purchase_simulated" : "failed",
        output: clean, elapsedMs: Date.now() - started });
    };
    const collect = (chunk: Buffer) => { output += chunk.toString(); if (output.length > 3000) output = output.slice(-3000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 45_000);
    child.on("error", () => finish(null));
    child.on("close", finish);
  });
}
async function worker(): Promise<void> {
  while (true) {
    const index = cursor++;
    if (index >= selected.length) return;
    const row = selected[index]!;
    row.fundedPurchaseSimulation = await run(row.token);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${index + 1}/${selected.length} ${row.token} ${row.fundedPurchaseSimulation.status}\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(retryFailed ? 1 : 2, selected.length) }, () => worker()));
