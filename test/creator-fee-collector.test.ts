import { describe, expect, it } from "vitest";
import { CreatorFeeCollector } from "../src/execution/creator-fee-collector.js";
import { Store } from "../src/store.js";

describe("independent creator fee collection", () => {
  it("runs without a graduation, respects its interval and resumes conversion after a restart", async () => {
    const store = new Store(":memory:");
    const calls: string[] = [];
    let failConversion = true;
    const actions = {
      async collectCreatorFees(id: string) { calls.push(`claim:${id}`); return { tx: "claimed" }; },
      async convertPumpToSol(id: string) {
        calls.push(`convert:${id}`);
        if (failConversion) { failConversion = false; throw new Error("temporary route failure"); }
        return { tx: "converted" };
      },
    };
    const collector = new CreatorFeeCollector(store, actions);
    await expect(collector.tick(100_000)).rejects.toThrow("temporary route failure");
    const restarted = new CreatorFeeCollector(store, actions);
    expect(await restarted.tick(105_000)).toBe(true);
    expect(calls).toEqual([
      "claim:creator-fees:1:collect",
      "convert:creator-fees:1:convert",
      "convert:creator-fees:1:convert",
    ]);
    expect(await restarted.tick(110_000)).toBe(false);
    expect(await restarted.tick(165_000)).toBe(true);
    expect(calls.slice(-2)).toEqual([
      "claim:creator-fees:2:collect", "convert:creator-fees:2:convert",
    ]);
    store.close();
  });
});
