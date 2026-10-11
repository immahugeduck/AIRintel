import { watchAreaInputSchema, watchAreaResponseSchema, type WatchAreaInput } from "../domain/net";
import { historyApiEndpoint, resolveApiUrl } from "../lib/api-url";
import { getAccessToken, getAuthClient } from "../lib/auth";
import { AccessDeniedError, AuthenticationRequiredError, ProviderNotConfiguredError } from "../providers/contracts";

/** Raised when the database has not had migration 0005 applied yet. */
export class NetNotMigratedError extends Error {
  constructor() {
    super("The always-on net is not set up on the server yet (database migration 0005 has not been applied).");
    this.name = "NetNotMigratedError";
  }
}

async function request(method: "GET" | "PUT", body: WatchAreaInput | null, signal?: AbortSignal) {
  if (!getAuthClient()) throw new ProviderNotConfiguredError();
  const token = await getAccessToken();
  if (!token) throw new AuthenticationRequiredError();
  const url = resolveApiUrl(historyApiEndpoint());
  url.searchParams.set("action", "watch-area");
  const response = await fetch(url, {
    method,
    ...(signal ? { signal } : {}),
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    if (response.status === 401) throw new AuthenticationRequiredError();
    if (response.status === 403 && payload?.error === "history_access_denied") throw new AccessDeniedError("history");
    if (response.status === 503 && payload?.error === "database_not_configured") throw new ProviderNotConfiguredError();
    if (response.status === 503 && payload?.error === "net_not_migrated") throw new NetNotMigratedError();
    if (response.status === 429) throw new Error("Too many requests. Wait a moment and try again.");
    throw new Error(`The net could not be updated (server answered ${response.status}).`);
  }
  return watchAreaResponseSchema.parse(await response.json());
}

/** The signed-in user's server-side watch area and net freshness. */
export const fetchWatchArea = (signal?: AbortSignal) => request("GET", null, signal);

/** Save, enable or pause the always-on net for the signed-in user. */
export const saveWatchArea = (input: WatchAreaInput) => request("PUT", watchAreaInputSchema.parse(input));
