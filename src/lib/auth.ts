import { createAuthClient, isAuthApiError } from "@neon/auth";
import { BetterAuthVanillaAdapter } from "@neon/auth/vanilla/adapters";

const createClient = (url: string) => createAuthClient(url, { adapter: BetterAuthVanillaAdapter() });
export type NeonAuthClient = ReturnType<typeof createClient>;

let client: NeonAuthClient | null | undefined;

/**
 * Picks the Neon Auth URL: VITE_NEON_AUTH_URL wins, otherwise SERVERSIDE_NEON_VITE_NEON_AUTH_URL (the name the
 * Vercel Neon integration uses). Blank values count as unset.
 */
export function pickNeonAuthUrl(plain: string | undefined, prefixed: string | undefined): string | undefined {
  return plain?.trim() || prefixed?.trim() || undefined;
}

/**
 * Neon Auth (Managed Better Auth) browser client, or null when neither VITE_NEON_AUTH_URL nor
 * SERVERSIDE_NEON_VITE_NEON_AUTH_URL is configured. Both are referenced statically so Vite inlines them at build
 * time (SERVERSIDE_NEON_VITE_ is exposed through `envPrefix` in vite.config.ts).
 */
export function getAuthClient(): NeonAuthClient | null {
  if (client !== undefined) return client;
  const url = pickNeonAuthUrl(import.meta.env.VITE_NEON_AUTH_URL, import.meta.env.SERVERSIDE_NEON_VITE_NEON_AUTH_URL);
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
 * The managed SDK's `token()` endpoint returns the JWT in `data.token`; `getSession()`
 * may contain an opaque session credential instead. The API gateway verifies the JWT against
 * the Neon Auth JWKS, so the browser never holds a database credential. The token is reused until ~1 minute
 * before it expires.
 */
export async function getAccessToken(): Promise<string | null> {
  const auth = getAuthClient();
  if (!auth) return null;
  if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached.token;
  try {
    // Use the SDK's public typed fetch: its 0.8.2 vanilla declarations omit the
    // inferred `token()` method, but /token is the documented managed JWT route.
    // This retains Neon's configured credentials, headers and response handling.
    const { data } = await auth.$fetch<{ token: string }>("/token", { method: "GET" });
    const candidate = data?.token;
    const token = typeof candidate === "string" && candidate.split(".").length === 3 ? candidate : null; // a JWT, not the opaque session id
    cached = token ? { token, expiresAtMs: jwtExpiryMs(token) } : null;
    return token;
  } catch (error) {
    // The supported SDK throws for HTTP failures; only an expired/missing session
    // is equivalent to signed out. Network/server errors must remain observable.
    if (!isAuthApiError(error) || error.status !== 401) throw error;
    cached = null;
    return null;
  }
}
