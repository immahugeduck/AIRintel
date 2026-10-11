import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bearerToken } from "../auth.js";
import type { NetConfig } from "../config.js";
import type { Queryable } from "../db.js";
import { log, errorFields } from "../logger.js";
import { SweepNotReadyError, runSweep } from "../net-sweep.js";
import type { AdsbProviderConfig, ProviderFetchOptions } from "../providers/adsb.js";

/** Constant-time string comparison: hashes both sides so length differences do not leak through timing. */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export type NetRouteDeps = {
  db: Queryable | null;
  adsb: AdsbProviderConfig | null;
  /** CRON_SECRET. Undefined/empty => the endpoint fails closed with 503. */
  cronSecret: string | undefined;
  net: NetConfig;
  fetchImpl?: typeof fetch;
  providerOptions?: ProviderFetchOptions;
};

const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/**
 * POST|GET /net/sweep (Vercel: /api/net/sweep). Not a browser endpoint: no CORS, no origin trust.
 * Auth is exactly `Authorization: Bearer ${CRON_SECRET}`, which Vercel Cron sends automatically when CRON_SECRET is set.
 * GET is accepted because Vercel Cron issues GET requests; POST is for GitHub Actions / external pingers.
 */
export function netRoutes(deps: NetRouteDeps) {
  const app = new Hono();

  const handler = async (c: Context) => {
    if (!deps.cronSecret) {
      log("error", "net_sweep_refused", { reason: "cron_secret_not_configured" });
      return c.json({ error: "sweep_not_configured" }, 503, noStore);
    }
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !secretsMatch(token, deps.cronSecret)) {
      log("warn", "net_sweep_refused", { reason: token ? "bad_secret" : "missing_secret" });
      return c.json({ error: "unauthorized" }, 401, { ...noStore, "WWW-Authenticate": 'Bearer realm="airintel-net"' });
    }
    if (!deps.db) return c.json({ error: "database_not_configured" }, 503, noStore);
    try {
      const summary = await runSweep({ db: deps.db, adsb: deps.adsb, net: deps.net, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.providerOptions ? { providerOptions: deps.providerOptions } : {}) });
      log(summary.ok ? "info" : "error", "net_sweep", { status: summary.status, durationMs: summary.durationMs, queried: summary.areas.queried, covered: summary.areas.covered, deferred: summary.areas.deferred, fetched: summary.observations.fetched, inserted: summary.observations.inserted, rejected: summary.observations.rejected });
      return c.json(summary, summary.status === "failed" ? 502 : 200, noStore);
    } catch (error) {
      if (error instanceof SweepNotReadyError) return c.json({ error: "net_not_migrated" }, 503, noStore);
      log("error", "net_sweep_failed", errorFields(error));
      return c.json({ error: "sweep_failed" }, 500, noStore);
    }
  };

  app.get("/sweep", handler);
  app.post("/sweep", handler);
  app.all("/sweep", (c) => c.json({ error: "method_not_allowed" }, 405, { ...noStore, Allow: "GET, POST" }));
  return app;
}
