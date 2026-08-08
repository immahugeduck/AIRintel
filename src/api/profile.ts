import { aircraftProfileSchema } from "../domain/profile";
import { getSupabaseClient } from "../lib/supabase";
import { AuthenticationRequiredError, ProviderNotConfiguredError } from "../providers/contracts";

export async function fetchAircraftProfile(icao24: string, signal?: AbortSignal) {
  const endpoint = import.meta.env.VITE_PROFILE_API_URL;
  if (!endpoint) throw new ProviderNotConfiguredError();
  const normalized = icao24.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(normalized)) throw new Error("ICAO24 must be six hexadecimal characters");
  const supabase = getSupabaseClient();
  if (!supabase) throw new ProviderNotConfiguredError();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AuthenticationRequiredError();
  const url = new URL(endpoint);
  url.searchParams.set("icao24", normalized);
  const response = await fetch(url, { ...(signal ? { signal } : {}), headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Aircraft profile gateway returned ${response.status}`);
  return aircraftProfileSchema.parse(await response.json());
}
