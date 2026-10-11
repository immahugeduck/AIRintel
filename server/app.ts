import { Hono } from "hono";
import { RateLimiter, type TokenVerifier } from "./auth.js";
import type { Queryable } from "./db.js";
import { originGuard, originGuardForMethods, requireAccess, type AppVariables } from "./http.js";
import type { ConfigIssue, NetConfig } from "./config.js";
import { healthNet } from "./net-watch.js";
import { NET_STALE_AFTER_MINUTES } from "../src/domain/net.js";
import type { AdsbProviderConfig, ProviderFetchOptions } from "./providers/adsb.js";
import { netRoutes } from "./routes/net.js";
import { aircraftRoutes } from "./routes/aircraft.js";
import { historyRoutes } from "./routes/history.js";
import { evidenceRoutes } from "./routes/evidence.js";
import { profileRoutes } from "./routes/profile.js";
import { satellitePassesRoutes, satellitesNearbyRoutes } from "./routes/satellites.js";

export type AppDependencies = {
  /** Neon Postgres (pooled DATABASE_URL). Null makes protected routes answer 503 database_not_configured. */
  db: Queryable | null;
  /** Neon Auth JWT verifier. Null makes protected routes answer 503 database_not_configured. */
  verifier: TokenVerifier | null;
  allowedOrigins: ReadonlySet<string>;
  adsb: AdsbProviderConfig | null;
  historyRateLimit?: number;
  profileRateLimit?: number;
  /** Per-user live-recording writes per minute (signed-in users with the history grant). */
  recordingRateLimit?: number;
  /** CRON_SECRET for /net/sweep. Undefined => the sweep endpoint fails closed (503). */
  cronSecret?: string | undefined;
  net?: NetConfig;
  /** Startup configuration problems; only variable names/levels are exposed on /health. */
  configIssues?: readonly ConfigIssue[];
  /** Test hooks for the sweep's provider calls. */
  sweepFetch?: typeof fetch;
  sweepProviderOptions?: ProviderFetchOptions;
};

const DEFAULT_NET: NetConfig = { maxAreas: 25, marginFactor: 2, minIntervalSeconds: 30, budgetMs: 22_000, retentionDays: undefined };

/**
 * One portable Fetch-API app that replaces the five Supabase Edge Functions.
 *   GET /health               liveness (no origin check)
 *   GET /aircraft-nearby      live ADS-B gateway (provider-gated); records to the flight recorder for JWT + "history" callers
 *   GET /history              search / track / insights / route-summary / nearby / netted / watch-area   (JWT + "history" grant)
 *   PUT /history?action=watch-area   save / enable / pause the always-on net            (JWT + "history" grant)
 *   GET|POST /net/sweep       always-on net sweep, Bearer CRON_SECRET (fails closed when unset)
 *   GET /aircraft-profile     FAA-registry-backed profile                          (JWT + "profile" grant)
 *   GET /satellites-nearby    CelesTrak/SGP4 positions
 *   GET /satellite-passes     CelesTrak/SGP4 pass prediction
 *   POST /evidence/upload     authenticated image upload to Vercel Blob
 *   GET /evidence/view        authenticated Blob image streaming
 */
export function createApp(deps: AppDependencies) {
  const app = new Hono<{ Variables: AppVariables }>();
  const guard = originGuard(deps.allowedOrigins);

  // Liveness + a secret-free readiness summary. Always 200 so a degraded dependency never looks like an outage of the app itself.
  app.get("/health", async (c) => {
    const errors = (deps.configIssues ?? []).filter((issue) => issue.level === "error").map((issue) => issue.variable);
    return c.json({
      ok: true,
      database: deps.db !== null,
      auth: deps.verifier !== null,
      provider: deps.adsb !== null,
      sweep: { secretConfigured: Boolean(deps.cronSecret) },
      net: deps.db ? await healthNet(deps.db, NET_STALE_AFTER_MINUTES) : { state: "unknown", lastSweepAgeSeconds: null, lastStatus: null },
      config: errors.length === 0 ? "ok" : "degraded",
      ...(errors.length > 0 ? { configErrors: errors } : {}),
    }, 200, { "Cache-Control": "no-store" });
  });

  // Secret-protected sweep (Vercel Cron / GitHub Actions / external pinger). No browser origin trust here.
  app.route("/net", netRoutes({ db: deps.db, adsb: deps.adsb, cronSecret: deps.cronSecret, net: deps.net ?? DEFAULT_NET, ...(deps.sweepFetch ? { fetchImpl: deps.sweepFetch } : {}), ...(deps.sweepProviderOptions ? { providerOptions: deps.sweepProviderOptions } : {}) }));

  app.use("/aircraft-nearby", guard);
  const recordingLimiter = new RateLimiter(deps.recordingRateLimit ?? 12);
  app.route("/aircraft-nearby", aircraftRoutes({ adsb: deps.adsb, recording: { db: deps.db, verifier: deps.verifier, limiter: recordingLimiter } }));

  app.use("/satellites-nearby", guard);
  app.route("/satellites-nearby", satellitesNearbyRoutes());
  app.use("/satellite-passes", guard);
  app.route("/satellite-passes", satellitePassesRoutes());

  const historyLimiter = new RateLimiter(deps.historyRateLimit ?? 30);
  app.use("/history", originGuardForMethods(deps.allowedOrigins, ["GET", "PUT"]));
  app.use("/history", requireAccess({ db: deps.db, verifier: deps.verifier, scope: "history", deniedError: "history_access_denied", limiter: historyLimiter }));
  if (deps.db) app.route("/history", historyRoutes(deps.db));

  const profileLimiter = new RateLimiter(deps.profileRateLimit ?? 20);
  app.use("/aircraft-profile", guard);
  app.use("/aircraft-profile", requireAccess({ db: deps.db, verifier: deps.verifier, scope: "profile", deniedError: "profile_access_denied", limiter: profileLimiter }));
  if (deps.db) app.route("/aircraft-profile", profileRoutes(deps.db));

  const evidenceLimiter = new RateLimiter(12);
  app.use("/evidence/*", originGuardForMethods(deps.allowedOrigins, ["GET", "POST"]));
  app.use("/evidence/*", requireAccess({ db: deps.db, verifier: deps.verifier, scope: "history", deniedError: "evidence_access_denied", limiter: evidenceLimiter }));
  app.route("/evidence", evidenceRoutes());

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}
