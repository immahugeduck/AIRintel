import { z } from "zod";
import { MAX_WATCH_RADIUS_MI, MIN_WATCH_RADIUS_MI, WATCH_RADIUS_MI } from "./units.js";

/**
 * The always-on "net": a server-side watch area that a scheduled sweep (POST/GET /api/net/sweep) polls for REAL
 * aircraft and writes through the flight recorder, so passes are logged while the app is closed.
 * Entry counting is still defined only by `netted-visits-v1` in ./netted.ts; the sweep only supplies observations.
 */

/** A net with no successful sweep for this long (while enabled) is reported as stale. */
export const NET_STALE_AFTER_MINUTES = 15;

export const watchAreaInputSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  radiusMi: z.number().finite().min(MIN_WATCH_RADIUS_MI).max(MAX_WATCH_RADIUS_MI).default(WATCH_RADIUS_MI),
  enabled: z.boolean(),
}).strict();
export type WatchAreaInput = z.infer<typeof watchAreaInputSchema>;

const utc = z.iso.datetime({ offset: true });

/** paused: no area or disabled · pending: enabled, waiting for the first sweep · active: swept recently · stale: enabled but no recent success. */
export const netStateSchema = z.enum(["paused", "pending", "active", "stale"]);
export type NetState = z.infer<typeof netStateSchema>;

export const netStatusSchema = z.object({
  state: netStateSchema,
  /** Last successful sweep of this user's area (UTC), null if never. */
  lastSuccessAt: utc.nullable(),
  /** Last sweep attempt, successful or not. */
  lastPolledAt: utc.nullable(),
  /** Machine code of the last attempt: ok, provider_error, record_error, partial… or null. */
  lastPollStatus: z.string().max(64).nullable(),
  staleAfterMinutes: z.number().int().positive(),
});
export type NetStatus = z.infer<typeof netStatusSchema>;

export const savedWatchAreaSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  radiusMi: z.number().finite().min(MIN_WATCH_RADIUS_MI).max(MAX_WATCH_RADIUS_MI),
  enabled: z.boolean(),
  createdAt: utc,
  updatedAt: utc,
});
export type SavedWatchArea = z.infer<typeof savedWatchAreaSchema>;

export const watchAreaResponseSchema = z.object({
  watchArea: savedWatchAreaSchema.nullable(),
  net: netStatusSchema,
  receivedAt: utc,
});
export type WatchAreaResponse = z.infer<typeof watchAreaResponseSchema>;

export type NetStateInput = {
  enabled: boolean;
  updatedAt: string | null;
  lastSuccessAt: string | null;
  lastPolledAt: string | null;
  lastPollStatus: string | null;
};

/** Pure, deterministic status used by the API (and tests). `now` is injectable. */
export function deriveNetStatus(area: NetStateInput | null, now: Date = new Date()): NetStatus {
  const base = { staleAfterMinutes: NET_STALE_AFTER_MINUTES, lastSuccessAt: area?.lastSuccessAt ?? null, lastPolledAt: area?.lastPolledAt ?? null, lastPollStatus: area?.lastPollStatus ?? null };
  if (!area || !area.enabled) return { state: "paused", ...base };
  const staleMs = NET_STALE_AFTER_MINUTES * 60_000;
  if (area.lastSuccessAt) {
    return { state: now.getTime() - Date.parse(area.lastSuccessAt) > staleMs ? "stale" : "active", ...base };
  }
  // Never swept successfully: give a freshly enabled net the same grace period before warning.
  const enabledFor = area.updatedAt ? now.getTime() - Date.parse(area.updatedAt) : Infinity;
  return { state: enabledFor > staleMs ? "stale" : "pending", ...base };
}

/** "just now", "2 min ago", "3 h ago", "2 d ago"; null for unknown timestamps. */
export function formatAgo(isoTimestamp: string | null | undefined, now: Date = new Date()): string | null {
  if (!isoTimestamp) return null;
  const then = Date.parse(isoTimestamp);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Human status line: "Net active — last sweep 2 min ago", "Net paused", … */
export function describeNetStatus(status: NetStatus, now: Date = new Date()): { tone: "ok" | "warn" | "idle" | "error"; text: string } {
  const ago = formatAgo(status.lastSuccessAt, now);
  switch (status.state) {
    case "paused": return { tone: "idle", text: "Net paused" };
    case "pending": return { tone: "idle", text: "Net enabled — waiting for the first sweep" };
    case "active": return { tone: "ok", text: `Net active — last sweep ${ago ?? "recently"}` };
    case "stale": {
      const failure = status.lastPollStatus && status.lastPollStatus !== "ok" ? ` (last attempt: ${status.lastPollStatus.replaceAll("_", " ")})` : "";
      return { tone: "warn", text: ago ? `Net stale — no successful sweep since ${ago}${failure}` : `Net stale — no sweep has completed yet${failure}` };
    }
  }
}
