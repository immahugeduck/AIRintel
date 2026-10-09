import { aircraftProfileSchema } from "../domain/profile";
import { profileApiEndpoint, resolveApiUrl } from "../lib/api-url";
import { getAccessToken, getAuthClient } from "../lib/auth";
import { AccessDeniedError, AuthenticationRequiredError, ProviderNotConfiguredError } from "../providers/contracts";

export async function fetchAircraftProfile(icao24: string, signal?: AbortSignal) {
  const normalized = icao24.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(normalized)) throw new Error("ICAO24 must be six hexadecimal characters");
  if (!getAuthClient()) throw new ProviderNotConfiguredError();
  const token = await getAccessToken();
  if (!token) throw new AuthenticationRequiredError();
  const url = resolveApiUrl(profileApiEndpoint());
  url.searchParams.set("icao24", normalized);
  const response = await fetch(url, { ...(signal ? { signal } : {}), headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (response.status === 401) throw new AuthenticationRequiredError();
    if (response.status === 403 && body?.error === "profile_access_denied") throw new AccessDeniedError("profile");
    if (response.status === 503 && body?.error === "database_not_configured") throw new ProviderNotConfiguredError();
    if (response.status === 404) throw new ProfileNotFoundError();
    throw new Error(`Aircraft profile gateway returned ${response.status}`);
  }
  return aircraftProfileSchema.parse(await response.json());
}

/** The aircraft has never been recorded, so no profile exists yet. */
export class ProfileNotFoundError extends Error {
  constructor() { super("This aircraft has not been recorded yet, so no profile is available."); this.name = "ProfileNotFoundError"; }
}
