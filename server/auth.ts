import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Queryable } from "./db";

export type AccessScope = "history" | "profile";
export type AuthenticatedUser = { id: string; email: string | null };
export type TokenVerifier = (token: string) => Promise<AuthenticatedUser | null>;

/**
 * Verifies a Neon Auth (Managed Better Auth) JWT. Tokens are EdDSA-signed, short-lived (15 min),
 * issued with the Neon Auth URL origin as issuer, and carry the user id in `sub`.
 */
export function createJwtVerifier(options: { jwksUrl?: string; keys?: JWTVerifyGetKey; baseUrl: string }): TokenVerifier {
  const keys = options.keys ?? createRemoteJWKSet(new URL(options.jwksUrl ?? `${options.baseUrl.replace(/\/+$/, "")}/.well-known/jwks.json`));
  const issuer = new URL(options.baseUrl).origin;
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, { issuer, algorithms: ["EdDSA"] });
      if (typeof payload.sub !== "string" || payload.banned === true) return null;
      return { id: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
    } catch {
      return null;
    }
  };
}

export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the user holds the scope in airintel_private.access_grants (managed with `npm run access:grant`). */
export async function hasScope(db: Queryable, userId: string, scope: AccessScope): Promise<boolean> {
  if (!uuidPattern.test(userId)) return false;
  const { rows } = await db.query<{ allowed: boolean }>("select $2 = any(scopes) as allowed from airintel_private.access_grants where user_id = $1::uuid", [userId, scope]);
  return rows[0]?.allowed === true;
}

/** Fixed-window, process-local limiter. Replace with a shared store before multi-instance public exposure. */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}

  /** Returns null when allowed, otherwise the number of seconds until the window resets. */
  hit(key: string): number | null {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return null;
    }
    if (bucket.count >= this.limit) return Math.ceil((bucket.resetAt - now) / 1000);
    bucket.count += 1;
    return null;
  }
}
