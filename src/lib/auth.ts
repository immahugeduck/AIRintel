import { createAuthClient } from "@neondatabase/neon-js/auth";
import { BetterAuthVanillaAdapter } from "@neondatabase/neon-js/auth/vanilla/adapters";

const createClient = (url: string) => createAuthClient(url, { adapter: BetterAuthVanillaAdapter() });
export type NeonAuthClient = ReturnType<typeof createClient>;

let client: NeonAuthClient | null | undefined;

/** Neon Auth (Managed Better Auth) browser client, or null when VITE_NEON_AUTH_URL is not configured. */
export function getAuthClient(): NeonAuthClient | null {
  if (client !== undefined) return client;
  const url = import.meta.env.VITE_NEON_AUTH_URL;
  client = url ? createClient(url) : null;
  return client;
}

let cached: { token: string; expiresAtMs: number } | null = null;

function jwtExpiryMs(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Forget the cached token (call after sign-in or sign-out). */
export function clearAccessToken() {
  cached = null;
}

/**
 * Returns a short-lived (15 minute) Neon Auth JWT for the signed-in user, or null when signed out.
 * Neon Auth's `getSession()` response carries the JWT in `session.token`. The API gateway verifies it against
 * the Neon Auth JWKS, so the browser never holds a database credential. The token is reused until ~1 minute
 * before it expires.
 */
export async function getAccessToken(): Promise<string | null> {
  const auth = getAuthClient();
  if (!auth) return null;
  if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached.token;
  const { data } = await auth.getSession();
  const candidate = data?.session?.token;
  const token = typeof candidate === "string" && candidate.split(".").length === 3 ? candidate : null; // a JWT, not the opaque session id
  cached = token ? { token, expiresAtMs: jwtExpiryMs(token) } : null;
  return token;
}
