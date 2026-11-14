import { MIN_CONTROL_SEPARATION_MI, controlAreaInputSchema, controlAreasResponseSchema, watchAreaInputSchema, watchAreaResponseSchema, type ControlAreaInput, type WatchAreaInput } from "../domain/net";
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

/** Raised when a control circle is too close to the user's own watch center to be a comparison. */
export class ControlTooCloseError extends Error {
  constructor(readonly distanceMi: number, readonly requiredMi: number = MIN_CONTROL_SEPARATION_MI) {
    super(`A control circle must not overlap places you are netted at: it needs to be at least ${requiredMi} mi from your watch circle and from places you regularly use with follow me (2+ days in the last 30; this one is ${distanceMi} mi away). Pick a place you do not go, or use a smaller radius.`);
    this.name = "ControlTooCloseError";
  }
}

async function controlRequest(method: "GET" | "PUT" | "DELETE", options: { body?: unknown; slot?: number; signal?: AbortSignal } = {}) {
  if (!getAuthClient()) throw new ProviderNotConfiguredError();
  const token = await getAccessToken();
  if (!token) throw new AuthenticationRequiredError();
  const url = resolveApiUrl(historyApiEndpoint());
  url.searchParams.set("action", "control-areas");
  if (options.slot !== undefined) url.searchParams.set("slot", String(options.slot));
  const response = await fetch(url, {
    method,
    ...(options.signal ? { signal: options.signal } : {}),
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string; distanceMi?: number; requiredMi?: number } | null;
    if (response.status === 401) throw new AuthenticationRequiredError();
    if (response.status === 403 && payload?.error === "history_access_denied") throw new AccessDeniedError("history");
    if (response.status === 503 && payload?.error === "database_not_configured") throw new ProviderNotConfiguredError();
    if (response.status === 503 && payload?.error === "net_not_migrated") throw new NetNotMigratedError();
    if (response.status === 422 && payload?.error === "control_too_close") throw new ControlTooCloseError(payload.distanceMi ?? 0, payload.requiredMi ?? MIN_CONTROL_SEPARATION_MI);
    if (response.status === 429) throw new Error("Too many requests. Wait a moment and try again.");
    throw new Error(`The control circles could not be updated (server answered ${response.status}).`);
  }
  return controlAreasResponseSchema.parse(await response.json());
}

/** The signed-in user's control circles with 7-day counts next to their own. */
export const fetchControlAreas = (signal?: AbortSignal) => controlRequest("GET", signal ? { signal } : {});
/** Save one control circle (slot 1 or 2). */
export const saveControlArea = (input: ControlAreaInput) => controlRequest("PUT", { body: controlAreaInputSchema.parse(input) });
/** Remove one control circle and its counts. */
export const deleteControlArea = (slot: number) => controlRequest("DELETE", { slot });
