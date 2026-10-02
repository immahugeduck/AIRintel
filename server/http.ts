import type { Context, MiddlewareHandler } from "hono";
import { bearerToken, hasScope, type AccessScope, type AuthenticatedUser, type RateLimiter, type TokenVerifier } from "./auth";
import type { Queryable } from "./db";

export type AppVariables = { origin: string; user: AuthenticatedUser };
export type AppContext = Context<{ Variables: AppVariables }>;

const baseHeaders = { Vary: "Origin", "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/** Rejects non-allow-listed origins, answers CORS preflight, and only permits GET. */
export const originGuard = (allowedOrigins: ReadonlySet<string>): MiddlewareHandler<{ Variables: AppVariables }> => async (c, next) => {
  const origin = c.req.header("origin") ?? "";
  if (!allowedOrigins.has(origin)) return c.json({ error: "origin_not_allowed" }, 403, baseHeaders);
  c.set("origin", origin);
  const cors = { ...baseHeaders, "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type" };
  if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (c.req.method !== "GET") return c.json({ error: "method_not_allowed" }, 405, cors);
  for (const [name, value] of Object.entries(cors)) c.header(name, value);
  await next();
};

export type AuthOptions = {
  db: Queryable | null;
  verifier: TokenVerifier | null;
  scope: AccessScope;
  deniedError: string;
  limiter: RateLimiter;
};

/** Verifies the Neon Auth JWT, checks the per-user access grant, then applies the per-user rate limit. */
export const requireAccess = (options: AuthOptions): MiddlewareHandler<{ Variables: AppVariables }> => async (c, next) => {
  if (!options.db || !options.verifier) return c.json({ error: "database_not_configured" }, 503);
  const token = bearerToken(c.req.header("authorization"));
  if (!token) return c.json({ error: "authentication_required" }, 401);
  const user = await options.verifier(token);
  if (!user) return c.json({ error: "authentication_required" }, 401);
  let allowed = false;
  try {
    allowed = await hasScope(options.db, user.id, options.scope);
  } catch {
    return c.json({ error: "access_check_failed" }, 500);
  }
  if (!allowed) return c.json({ error: options.deniedError }, 403);
  const retryAfterSeconds = options.limiter.hit(user.id);
  if (retryAfterSeconds !== null) return c.json({ error: "rate_limited", retryAfterSeconds }, 429);
  c.set("user", user);
  await next();
};

export const percentile = (values: number[], quantile: number) => {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = (ordered.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return ordered[lower]!;
  return ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (index - lower);
};
