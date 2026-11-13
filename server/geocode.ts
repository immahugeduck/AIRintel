import { z } from "zod";
import { geocodeQuerySchema, parseCoordinateText, type GeocodeResult } from "../src/domain/geocode.js";
import { errorFields, log } from "./logger.js";

/**
 * Address -> coordinates for the watch-area and control-circle forms. Runs server-side so the browser's CSP stays
 * `connect-src 'self'` and providers see the AIRIntel server, not the user's IP. Only the typed text is sent out.
 *
 * Order: typed coordinates (no network) -> U.S. Census Bureau geocoder (official, street addresses) ->
 * OpenStreetMap Nominatim (towns, landmarks, non-U.S.). Nominatim's usage policy allows light, user-initiated
 * lookups with an identifying User-Agent and no bulk/autocomplete use, which is how this is called.
 */

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "AIRIntel/0.1 (+https://github.com/immahugeduck/AIRintel)";
const TIMEOUT_MS = 6_000;

const censusSchema = z.object({
  result: z.object({
    addressMatches: z.array(z.object({
      matchedAddress: z.string(),
      coordinates: z.object({ x: z.number().finite(), y: z.number().finite() }),
    })),
  }),
});

const nominatimSchema = z.array(z.object({
  lat: z.coerce.number().finite(),
  lon: z.coerce.number().finite(),
  display_name: z.string(),
}));

const inRange = (latitude: number, longitude: number) => latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;

async function getJson(fetchImpl: typeof fetch, url: URL): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`geocoder_upstream_${response.status}`);
  return response.json();
}

export async function geocodeCensus(query: string, fetchImpl: typeof fetch = fetch): Promise<GeocodeResult | null> {
  const url = new URL(CENSUS_URL);
  url.searchParams.set("address", query);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  const parsed = censusSchema.safeParse(await getJson(fetchImpl, url));
  const match = parsed.success ? parsed.data.result.addressMatches[0] : undefined;
  if (!match || !inRange(match.coordinates.y, match.coordinates.x)) return null;
  return { latitude: match.coordinates.y, longitude: match.coordinates.x, label: match.matchedAddress, source: "us_census" };
}

export async function geocodeNominatim(query: string, fetchImpl: typeof fetch = fetch): Promise<GeocodeResult | null> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  const parsed = nominatimSchema.safeParse(await getJson(fetchImpl, url));
  const match = parsed.success ? parsed.data[0] : undefined;
  if (!match || !inRange(match.lat, match.lon)) return null;
  return { latitude: match.lat, longitude: match.lon, label: match.display_name.slice(0, 200), source: "openstreetmap" };
}

export type GeocodeOutcome = { status: "found"; result: GeocodeResult } | { status: "invalid" } | { status: "not_found" } | { status: "unavailable" };

/** Never throws. A provider error falls through to the next provider; all failing reports `unavailable`. */
export async function geocode(raw: string | undefined, fetchImpl: typeof fetch = fetch): Promise<GeocodeOutcome> {
  const parsed = geocodeQuerySchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid" };
  const coordinates = parseCoordinateText(parsed.data);
  if (coordinates) return { status: "found", result: coordinates };
  let failures = 0;
  for (const provider of [geocodeCensus, geocodeNominatim]) {
    try {
      const result = await provider(parsed.data, fetchImpl);
      if (result) return { status: "found", result };
    } catch (error) {
      failures += 1;
      log("warn", "geocode_provider_failed", { provider: provider.name, ...errorFields(error) });
    }
  }
  return failures === 2 ? { status: "unavailable" } : { status: "not_found" };
}
