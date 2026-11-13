import { geocodeResponseSchema, parseCoordinateText, type GeocodeResult } from "../domain/geocode";
import { historyApiEndpoint, resolveApiUrl } from "../lib/api-url";
import { getAccessToken, getAuthClient } from "../lib/auth";

/** User-facing lookup failure; `message` is ready to show in the form. */
export class GeocodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeocodeError";
  }
}

/**
 * Finds coordinates for an address, place name, or typed "lat, lon". Typed coordinates resolve locally (no sign-in
 * needed); anything else goes through the signed-in AIRIntel API, which calls the U.S. Census and OpenStreetMap
 * geocoders server-side.
 */
export async function lookupAddress(text: string, signal?: AbortSignal): Promise<GeocodeResult> {
  const query = text.trim();
  if (query.length < 3) throw new GeocodeError("Type an address, town, or coordinates.");
  const coordinates = parseCoordinateText(query);
  if (coordinates) return coordinates;
  if (!getAuthClient()) throw new GeocodeError("Address search is not configured on this deployment. Enter coordinates as \"lat, lon\" instead.");
  const token = await getAccessToken();
  if (!token) throw new GeocodeError("Sign in to search by address, or enter coordinates as \"lat, lon\".");
  const url = resolveApiUrl(historyApiEndpoint());
  url.searchParams.set("action", "geocode");
  url.searchParams.set("q", query);
  const response = await fetch(url, { ...(signal ? { signal } : {}), headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (response.ok) return geocodeResponseSchema.parse(await response.json()).result;
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (response.status === 404 || payload?.error === "address_not_found") throw new GeocodeError("No match found. Try adding the city and state, e.g. \"123 Main St, Greencastle, IN\".");
  if (response.status === 400) throw new GeocodeError("Type an address, town, or coordinates (3–200 characters).");
  if (response.status === 401) throw new GeocodeError("Sign in to search by address, or enter coordinates as \"lat, lon\".");
  if (response.status === 429) throw new GeocodeError("Too many lookups. Wait a moment and try again.");
  throw new GeocodeError("The address lookup services are not responding right now. Try again, or enter coordinates as \"lat, lon\".");
}
