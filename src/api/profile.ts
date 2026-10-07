import { aircraftProfileSchema } from "../domain/profile";
import { profileApiEndpoint, resolveApiUrl } from "../lib/api-url";
import { getAccessToken, getAuthClient } from "../lib/auth";
import { AuthenticationRequiredError, ProviderNotConfiguredError } from "../providers/contracts";

export async function fetchAircraftProfile(icao24: string, signal?: AbortSignal) {
  const normalized = icao24.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(normalized)) throw new Error("ICAO24 must be six hexadecimal characters");
  if (!getAuthClient()) throw new ProviderNotConfiguredError();
  const token = await getAccessToken();
  if (!token) throw new AuthenticationRequiredError();
  const url = resolveApiUrl(profileApiEndpoint());
  url.searchParams.set("icao24", normalized);
  const response = await fetch(url, { ...(signal ? { signal } : {}), headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Aircraft profile gateway returned ${response.status}`);
  return aircraftProfileSchema.parse(await response.json());
}
