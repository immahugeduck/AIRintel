/**
 * Resolves a configured API endpoint. Absolute URLs (separate API host) are used as-is; relative ones such as
 * "/api/history" (API served by the same Vercel project) resolve against the page origin.
 */
export function resolveApiUrl(endpoint: string): URL {
  const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  return new URL(endpoint, base);
}

/**
 * Same-origin Vercel defaults used when VITE_* API URLs are omitted from the build.
 * Evidence routes already hard-code /api/evidence/*; live/history/profile now follow the same pattern so
 * preview/production work without baking absolute API hosts into the SPA.
 */
export const DEFAULT_AIRCRAFT_API_URL = "/api/aircraft-nearby";
export const DEFAULT_HISTORY_API_URL = "/api/history";
export const DEFAULT_PROFILE_API_URL = "/api/aircraft-profile";

export function aircraftApiEndpoint(): string {
  return import.meta.env.VITE_AIRCRAFT_API_URL?.trim() || DEFAULT_AIRCRAFT_API_URL;
}

export function historyApiEndpoint(): string {
  return import.meta.env.VITE_HISTORY_API_URL?.trim() || DEFAULT_HISTORY_API_URL;
}

export function profileApiEndpoint(): string {
  return import.meta.env.VITE_PROFILE_API_URL?.trim() || DEFAULT_PROFILE_API_URL;
}
