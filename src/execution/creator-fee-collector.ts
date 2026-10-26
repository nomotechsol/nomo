import type { Store } from "../store.js";
import type { ExecutionAdapter } from "./engine.js";

type FeeActions = Pick<ExecutionAdapter, "collectCreatorFees" | "convertPumpToSol">;
type FeeRun = { id: number; stage: "collect" | "convert" };

/** Independently claim NOMO fees, including while its bonding curve is still live. */
export class CreatorFeeCollector {
  private running = false;

  constructor(private readonly store: Store, private readonly actions: FeeActions,
    private readonly intervalMs = 60_000) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
      throw new Error("Invalid creator fee collection interval");
    store.db.exec(`CREATE TABLE IF NOT EXISTS creator_fee_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage TEXT NOT NULL CHECK(stage IN ('collect','convert','done')),
      started_at INTEGER NOT NULL, completed_at INTEGER,
      collect_tx TEXT, conversion_tx TEXT)`);
  }

  /** A pending run resumes with the same operation IDs after a restart. */
  async tick(now = Date.now()): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      let run = this.store.db.prepare(`SELECT id, stage FROM creator_fee_runs
        WHERE stage != 'done' ORDER BY id LIMIT 1`).get() as FeeRun | undefined;
      if (!run) {
        const last = this.store.db.prepare(`SELECT MAX(completed_at) AS completedAt
          FROM creator_fee_runs`).get() as { completedAt: number | null };
        if (last.completedAt !== null && now - last.completedAt < this.intervalMs) return false;
        const result = this.store.db.prepare(`INSERT INTO creator_fee_runs
          (stage, started_at) VALUES ('collect', ?)`).run(now);
        run = { id: Number(result.lastInsertRowid), stage: "collect" };
      }
      const operation = `creator-fees:${run.id}`;
      if (run.stage === "collect") {
        const receipt = await this.actions.collectCreatorFees(`${operation}:collect`);
        this.store.db.prepare(`UPDATE creator_fee_runs SET stage = 'convert', collect_tx = ?
          WHERE id = ? AND stage = 'collect'`).run(receipt.tx, run.id);
      }
      const conversion = await this.actions.convertPumpToSol(`${operation}:convert`);
      this.store.db.prepare(`UPDATE creator_fee_runs SET stage = 'done', conversion_tx = ?, completed_at = ?
        WHERE id = ? AND stage = 'convert'`).run(conversion.tx, now, run.id);
      return true;
    } finally {
      this.running = false;
    }
  }
}
