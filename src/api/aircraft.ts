import { aircraftResponseSchema, radiusQuerySchema, type RadiusQuery } from "../domain/aircraft";
import { aircraftApiEndpoint, resolveApiUrl } from "../lib/api-url";

export async function fetchAircraft(query: RadiusQuery, signal?: AbortSignal) {
  const safe = radiusQuerySchema.parse(query);
  const url = resolveApiUrl(aircraftApiEndpoint());
  url.searchParams.set("lat", String(safe.latitude));
  url.searchParams.set("lon", String(safe.longitude));
  url.searchParams.set("radiusNm", String(safe.radiusNm));

  const response = await fetch(url, {
    ...(signal ? { signal } : {}),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Aircraft gateway returned ${response.status}`);
  return aircraftResponseSchema.parse(await response.json());
}
