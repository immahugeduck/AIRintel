import { ProviderNotConfiguredError } from "../providers/contracts";
import { aircraftResponseSchema, radiusQuerySchema, type RadiusQuery } from "../domain/aircraft";
import { aircraftApiEndpoint, resolveApiUrl } from "../lib/api-url";
import { getAccessToken } from "../lib/auth";

export async function fetchAircraft(query: RadiusQuery, signal?: AbortSignal) {
  const safe = radiusQuerySchema.parse(query);
  const url = resolveApiUrl(aircraftApiEndpoint());
  url.searchParams.set("lat", String(safe.latitude));
  url.searchParams.set("lon", String(safe.longitude));
  url.searchParams.set("radiusNm", String(safe.radiusNm));

  // When signed in, send the Neon Auth JWT so users with the history grant contribute these real observations
  // to the flight recorder (and therefore to the Netted Aircraft log). Anonymous viewing still works.
  const token = await getAccessToken().catch(() => null);
  const response = await fetch(url, {
    ...(signal ? { signal } : {}),
    headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (response.status === 503 && body?.error === "provider_not_configured") throw new ProviderNotConfiguredError();
    throw new Error(`Aircraft gateway returned ${response.status}`);
  }
  return aircraftResponseSchema.parse(await response.json());
}
