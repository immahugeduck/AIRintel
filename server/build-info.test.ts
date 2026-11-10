import { afterEach, describe, expect, it, vi } from "vitest";
import { buildId } from "./build-info.js";
import { healthNet } from "./net-watch.js";
import type { Queryable } from "./db.js";

afterEach(() => { vi.unstubAllEnvs(); });

describe("buildId", () => {
  it("reports the short commit of the running deployment so a stale sweep host can be told apart", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "acccd2e0123456789abcdef0123456789abcdef0");
    expect(buildId()).toBe("acccd2e");
  });
  it("falls back to other hosts' revision variables, then null", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("K_REVISION", "airintel-google-00042-abc");
    expect(buildId()).toBe("airintel-google-00042-abc");
    vi.stubEnv("K_REVISION", "");
    vi.stubEnv("GIT_COMMIT_SHA", "");
    expect(buildId()).toBeNull();
  });
});

describe("healthNet encounter tagging check", () => {
  const fake = (untagged: number, total: number): Queryable => ({
    query: async (text: string) => {
      if (/net_sweep_state/.test(text)) return { rows: [{ last_finished_at: new Date(Date.now() - 30_000), last_status: "completed" }] } as never;
      if (/net_watch_areas/.test(text)) return { rows: [{ present: true }] } as never;
      if (/center_mode/.test(text)) return { rows: [{ total, untagged }] } as never;
      throw new Error(`unexpected query ${text}`);
    },
  });
  it("counts recent sweep/live encounters written without a follow/fixed tag (a stale writer)", async () => {
    const net = await healthNet(fake(12, 12), 15);
    expect(net.recentEncounters).toEqual({ total: 12, untagged: 12 });
    expect(net.writer).toBe("stale_suspected");
  });
  it("reports the writer as current when new encounters are tagged", async () => {
    const net = await healthNet(fake(0, 5), 15);
    expect(net.writer).toBe("current");
  });
});
