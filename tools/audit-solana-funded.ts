import "dotenv/config";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve("reports/found-candidates-local-audit.json");
const report = JSON.parse(readFileSync(path, "utf8")) as {
  checks: Array<{ launchpad: string; token: string; localSimulation?: { status: string };
    fundedBuySimulation?: { status: string; output: string; elapsedMs: number } }>;
  fundedBuySimulationFinishedAt?: string;
};
const selected = report.checks.map((row, index) => ({ row, index }))
  .filter(({ row }) => row.launchpad === "pumpfun" &&
    row.localSimulation?.status === "funding_simulated_only");
let cursor = 0;
async function worker(): Promise<void> {
  while (true) {
    const at = cursor++;
    if (at >= selected.length) return;
    const { row, index } = selected[at]!;
    const started = Date.now();
    const check = await new Promise<{ status: string; output: string; elapsedMs: number }>((done) => {
      const child = spawn("npx", ["tsx", "tools/local-pump-funded-simulation.ts", row.token],
        { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let timedOut = false;
      let finished = false;
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        done({ status: timedOut ? "timeout" : code === 0 ? "purchase_simulated" : "failed",
          output: output.replace(/https?:\/\/[^\s"']+/g, "[rpc]").slice(-900).trim(),
          elapsedMs: Date.now() - started });
      };
      const collect = (chunk: Buffer) => { output += chunk.toString(); if (output.length > 3000) output = output.slice(-3000); };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 35_000);
      child.on("error", () => finish(null));
      child.on("close", finish);
    });
    report.checks[index]!.fundedBuySimulation = check;
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${at + 1}/${selected.length} ${row.token} ${check.status} ${check.elapsedMs}ms\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(2, selected.length) }, () => worker()));
report.fundedBuySimulationFinishedAt = new Date().toISOString();
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
