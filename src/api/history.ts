import { aircraftSearchResponseSchema, trackResponseSchema } from "../domain/aircraft";
import { getSupabaseClient } from "../lib/supabase";
import { AuthenticationRequiredError, ProviderNotConfiguredError } from "../providers/contracts";

const endpoint = () => {
  const value = import.meta.env.VITE_HISTORY_API_URL;
  if (!value) throw new ProviderNotConfiguredError();
  return value;
};

async function getJson(url: URL, signal?: AbortSignal) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new ProviderNotConfiguredError();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AuthenticationRequiredError();
  const response = await fetch(url, { ...(signal ? { signal } : {}), headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`History gateway returned ${response.status}`);
  return response.json() as Promise<unknown>;
}

export async function searchAircraft(search: string, signal?: AbortSignal) {
  const normalized = validateHistorySearch(search);
  const url = new URL(endpoint());
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
  const url = new URL(endpoint());
  url.searchParams.set("action", "track");
  url.searchParams.set("icao24", normalized);
  url.searchParams.set("hours", "24");
  return trackResponseSchema.parse(await getJson(url, signal));
}
