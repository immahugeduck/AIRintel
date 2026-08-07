import { aircraftResponseSchema, radiusQuerySchema, type RadiusQuery } from "../domain/aircraft";
import { ProviderNotConfiguredError } from "../providers/contracts";

export async function fetchAircraft(query: RadiusQuery, signal?: AbortSignal) {
  const endpoint = import.meta.env.VITE_AIRCRAFT_API_URL;
  if (!endpoint) throw new ProviderNotConfiguredError();

  const safe = radiusQuerySchema.parse(query);
  const url = new URL(endpoint);
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
