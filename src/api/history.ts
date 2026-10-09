import { aircraftSearchResponseSchema, nearbyAircraftResponseSchema, routeSummaryResponseSchema, trackResponseSchema, trackInsightsResponseSchema, type NearbyAircraftQuery, type RouteSummaryQuery, type TrackInsightsQuery } from "../domain/aircraft";
import { historyApiEndpoint, resolveApiUrl } from "../lib/api-url";
import { getAccessToken, getAuthClient } from "../lib/auth";
import { nettedQuerySchema, nettedResponseSchema } from "../domain/netted";
import { AccessDeniedError, AuthenticationRequiredError, ProviderNotConfiguredError } from "../providers/contracts";

const endpoint = () => historyApiEndpoint();

async function getJson(url: URL, signal?: AbortSignal) {
  if (!getAuthClient()) throw new ProviderNotConfiguredError();
  const token = await getAccessToken();
  if (!token) throw new AuthenticationRequiredError();
  const response = await fetch(url, { ...(signal ? { signal } : {}), headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (response.status === 401) throw new AuthenticationRequiredError();
    if (response.status === 403 && body?.error === "history_access_denied") throw new AccessDeniedError("history");
    if (response.status === 503 && body?.error === "database_not_configured") throw new ProviderNotConfiguredError();
    throw new Error(`History gateway returned ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

export async function searchAircraft(search: string, signal?: AbortSignal) {
  const normalized = validateHistorySearch(search);
  const url = resolveApiUrl(endpoint());
  url.searchParams.set("action", "search");
  url.searchParams.set("q", normalized);
  return aircraftSearchResponseSchema.parse(await getJson(url, signal));
}

export function validateHistorySearch(search: string) {
  const normalized = search.trim();
  if (normalized.length < 2 || normalized.length > 24) throw new Error("Search must contain 2–24 characters");
  if (!/^[a-zA-Z0-9-]+$/.test(normalized)) throw new Error("Search contains unsupported characters");
  return normalized;
}

export async function fetchRecentTrack(icao24: string, signal?: AbortSignal) {
  const normalized = icao24.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(normalized)) throw new Error("ICAO24 must be six hexadecimal characters");
  const url = resolveApiUrl(endpoint());
  url.searchParams.set("action", "track");
  url.searchParams.set("icao24", normalized);
  url.searchParams.set("hours", "24");
  return trackResponseSchema.parse(await getJson(url, signal));
}

export async function fetchTrackInsights(query: TrackInsightsQuery, signal?: AbortSignal) {
  const normalized = query.icao24.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(normalized)) throw new Error("ICAO24 must be six hexadecimal characters");
  const url = resolveApiUrl(endpoint());
  url.searchParams.set("action", "insights");
  url.searchParams.set("icao24", normalized);
  url.searchParams.set("hours", String(Math.min(72, Math.max(1, query.hours ?? 24))));
  return trackInsightsResponseSchema.parse(await getJson(url, signal));
}

export async function fetchRouteSummary(query: RouteSummaryQuery, signal?: AbortSignal) {
  const normalized = query.icao24.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(normalized)) throw new Error("ICAO24 must be six hexadecimal characters");
  const url = resolveApiUrl(endpoint());
  url.searchParams.set("action", "route-summary");
  url.searchParams.set("icao24", normalized);
  url.searchParams.set("hours", String(Math.min(72, Math.max(1, query.hours ?? 24))));
  return routeSummaryResponseSchema.parse(await getJson(url, signal));
}

export async function fetchNearbyAircraft(query: NearbyAircraftQuery, signal?: AbortSignal) {
  const safeQuery = {
    latitude: query.latitude,
    longitude: query.longitude,
    radiusNm: query.radiusNm,
  };
  const url = resolveApiUrl(endpoint());
  url.searchParams.set("action", "nearby");
  url.searchParams.set("lat", String(safeQuery.latitude));
  url.searchParams.set("lon", String(safeQuery.longitude));
  url.searchParams.set("radiusNm", String(Math.min(100, Math.max(1, safeQuery.radiusNm))));
  if (query.hours != null) url.searchParams.set("hours", String(Math.min(72, Math.max(1, query.hours))));
  return nearbyAircraftResponseSchema.parse(await getJson(url, signal));
}

/** Aircraft netted inside the watch radius with their visit counters (server-computed from recorded observations). */
export async function fetchNettedAircraft(query: { latitude: number; longitude: number; radiusMi: number; hours?: number }, signal?: AbortSignal) {
  const safe = nettedQuerySchema.parse({ lat: query.latitude, lon: query.longitude, radiusMi: query.radiusMi, hours: query.hours });
  const url = resolveApiUrl(endpoint());
  url.searchParams.set("action", "netted");
  url.searchParams.set("lat", String(safe.lat));
  url.searchParams.set("lon", String(safe.lon));
  url.searchParams.set("radiusMi", String(safe.radiusMi));
  url.searchParams.set("hours", String(safe.hours));
  return nettedResponseSchema.parse(await getJson(url, signal));
}
