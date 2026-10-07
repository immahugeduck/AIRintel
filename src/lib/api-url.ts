/**
 * Resolves a configured API endpoint. Absolute URLs (separate API host) are used as-is; relative ones such as
 * "/api/history" (API served by the same Vercel project) resolve against the page origin.
 */
export function resolveApiUrl(endpoint: string): URL {
  const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  return new URL(endpoint, base);
}
