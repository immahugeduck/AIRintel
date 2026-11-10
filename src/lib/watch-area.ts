import { z } from "zod";
import { distanceNm } from "../domain/geometry";
import { MAX_WATCH_RADIUS_MI, METERS_PER_STATUTE_MILE, MIN_WATCH_RADIUS_MI, WATCH_RADIUS_MI, nmToMiles } from "../domain/units";

/**
 * The user's watch area ("my location" + radius in statute miles).
 * Source priority: a saved/entered location in this browser -> device geolocation (only after the user taps
 * "Use my location") -> the deployment default (VITE_DEFAULT_CENTER_LAT/LON). Radius defaults to 7 mi.
 * `followMe` keeps the center on the phone: while the app is open, a fix more than FOLLOW_RECENTER_MI from the center
 * moves it (see shouldRecenter / useFollowMe).
 */
export type LocationSource = "default" | "saved" | "device";
export type WatchArea = { latitude: number; longitude: number; radiusMi: number; source: LocationSource; updatedAt: string | null; followMe?: boolean | undefined };

export const WATCH_AREA_STORAGE_KEY = "airintel.watchArea.v1";

/** Follow me re-centers once the phone is more than this far (statute miles) from the current center. */
export const FOLLOW_RECENTER_MI = 1;
/** Fixes less precise than this (meters, 95% radius reported by the browser) are ignored, so GPS jitter never moves the circle. */
export const FOLLOW_MAX_ACCURACY_M = METERS_PER_STATUTE_MILE;

const storedSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  radiusMi: z.number().finite().min(MIN_WATCH_RADIUS_MI).max(MAX_WATCH_RADIUS_MI),
  source: z.enum(["default", "saved", "device"]),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
  followMe: z.boolean().optional(),
});

export type LocationFix = { latitude: number; longitude: number; accuracyM: number | null };

/** Pure: true when a follow-me fix is precise enough and far enough from the current center to move it. */
export function shouldRecenter(area: Pick<WatchArea, "latitude" | "longitude" | "source">, fix: LocationFix, thresholdMi = FOLLOW_RECENTER_MI): boolean {
  if (!Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return false;
  if (fix.accuracyM !== null && (!Number.isFinite(fix.accuracyM) || fix.accuracyM > FOLLOW_MAX_ACCURACY_M)) return false;
  // A default center is never "where you are", so the first good fix always replaces it.
  if (area.source === "default") return true;
  return nmToMiles(distanceNm(area.latitude, area.longitude, fix.latitude, fix.longitude)) > thresholdMi;
}

/** The area after a follow-me fix moved it. */
export const recenterOn = (area: WatchArea, fix: LocationFix, now: Date = new Date()): WatchArea =>
  ({ ...area, latitude: fix.latitude, longitude: fix.longitude, source: "device", followMe: true, updatedAt: now.toISOString() });

const envNumber = (value: string | undefined, fallback: number) => {
  const parsed = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const clampRadiusMi = (value: number) => Math.min(MAX_WATCH_RADIUS_MI, Math.max(MIN_WATCH_RADIUS_MI, value));

export function defaultWatchArea(env: { lat?: string | undefined; lon?: string | undefined; radiusMi?: string | undefined } = {
  lat: import.meta.env.VITE_DEFAULT_CENTER_LAT,
  lon: import.meta.env.VITE_DEFAULT_CENTER_LON,
  radiusMi: import.meta.env.VITE_DEFAULT_RADIUS_MI,
}): WatchArea {
  return {
    latitude: Math.max(-90, Math.min(90, envNumber(env.lat, 39.7684))),
    longitude: Math.max(-180, Math.min(180, envNumber(env.lon, -86.1581))),
    radiusMi: clampRadiusMi(envNumber(env.radiusMi, WATCH_RADIUS_MI)),
    source: "default",
    updatedAt: null,
  };
}

export function loadWatchArea(storage: Pick<Storage, "getItem"> | null = safeStorage()): WatchArea {
  const fallback = defaultWatchArea();
  try {
    const raw = storage?.getItem(WATCH_AREA_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = storedSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return fallback;
    // A stored "default" area only remembers the radius; coordinates follow the deployment default.
    return parsed.data.source === "default" ? { ...fallback, radiusMi: parsed.data.radiusMi, updatedAt: parsed.data.updatedAt, ...(parsed.data.followMe ? { followMe: true } : {}) } : parsed.data;
  } catch {
    return fallback;
  }
}

export function saveWatchArea(area: WatchArea, storage: Pick<Storage, "setItem"> | null = safeStorage()) {
  try { storage?.setItem(WATCH_AREA_STORAGE_KEY, JSON.stringify(area)); } catch { /* storage is optional (private mode) */ }
}

function safeStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/** Human-readable reason for a geolocation failure. */
export function geolocationErrorMessage(code: number | null): string {
  if (code === 1) return "Location permission was denied. You can allow it in your browser settings, or enter a location below.";
  if (code === 2) return "Your device could not determine its location. Try again outdoors or enter a location below.";
  if (code === 3) return "Locating took too long. Try again or enter a location below.";
  return "Location is not available in this browser. Enter a location below.";
}
