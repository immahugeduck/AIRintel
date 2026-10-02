import { Hono } from "hono";
import { RateLimiter, type TokenVerifier } from "./auth";
import type { Queryable } from "./db";
import { originGuard, requireAccess, type AppVariables } from "./http";
import { aircraftRoutes } from "./routes/aircraft";
import { historyRoutes } from "./routes/history";
import { profileRoutes } from "./routes/profile";
import { satellitePassesRoutes, satellitesNearbyRoutes } from "./routes/satellites";

export type AppDependencies = {
  /** Neon Postgres (pooled DATABASE_URL). Null makes protected routes answer 503 database_not_configured. */
  db: Queryable | null;
  /** Neon Auth JWT verifier. Null makes protected routes answer 503 database_not_configured. */
  verifier: TokenVerifier | null;
  allowedOrigins: ReadonlySet<string>;
  adsbConfigured: boolean;
  historyRateLimit?: number;
  profileRateLimit?: number;
};

/**
 * One portable Fetch-API app that replaces the five Supabase Edge Functions.
 *   GET /health               liveness (no origin check)
 *   GET /aircraft-nearby      live ADS-B gateway (provider-gated)
 *   GET /history              search / track / insights / route-summary / nearby   (JWT + "history" grant)
 *   GET /aircraft-profile     FAA-registry-backed profile                          (JWT + "profile" grant)
 *   GET /satellites-nearby    CelesTrak/SGP4 positions
 *   GET /satellite-passes     CelesTrak/SGP4 pass prediction
 */
export function createApp(deps: AppDependencies) {
  const app = new Hono<{ Variables: AppVariables }>();
  const guard = originGuard(deps.allowedOrigins);

  app.get("/health", (c) => c.json({ ok: true, database: deps.db !== null, auth: deps.verifier !== null }));

  app.use("/aircraft-nearby", guard);
  app.route("/aircraft-nearby", aircraftRoutes({ providerConfigured: deps.adsbConfigured }));

  app.use("/satellites-nearby", guard);
  app.route("/satellites-nearby", satellitesNearbyRoutes());
  app.use("/satellite-passes", guard);
  app.route("/satellite-passes", satellitePassesRoutes());

  const historyLimiter = new RateLimiter(deps.historyRateLimit ?? 30);
  app.use("/history", guard);
  app.use("/history", requireAccess({ db: deps.db, verifier: deps.verifier, scope: "history", deniedError: "history_access_denied", limiter: historyLimiter }));
  if (deps.db) app.route("/history", historyRoutes(deps.db));

  const profileLimiter = new RateLimiter(deps.profileRateLimit ?? 20);
  app.use("/aircraft-profile", guard);
  app.use("/aircraft-profile", requireAccess({ db: deps.db, verifier: deps.verifier, scope: "profile", deniedError: "profile_access_denied", limiter: profileLimiter }));
  if (deps.db) app.route("/aircraft-profile", profileRoutes(deps.db));

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}
