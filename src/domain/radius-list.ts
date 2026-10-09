import { distanceNm } from "./geometry";

/** One clean row of the "Aircraft in radius" list. All values come from a real observation; null means Unknown. */
export type RadiusRow = {
  icao24: string;
  callsign: string | null;
  registration: string | null;
  distanceNm: number;
  altitudeFt: number | null;
  onGround: boolean | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  observedAt: string;
  /** "live" = this session's live gateway, "recorded" = flight recorder (last 24 h). */
  origin: "live" | "recorded";
  provider: string | null;
  latitude: number;
  longitude: number;
};

type Candidate = {
  icao24: string;
  callsign?: string | null | undefined;
  registration?: string | null | undefined;
  latitude: number;
  longitude: number;
  altitudeFt?: number | null | undefined;
  onGround?: boolean | null | undefined;
  groundSpeedKt?: number | null | undefined;
  trackDeg?: number | null | undefined;
  observedAt: string;
  provider?: string | null | undefined;
};

/**
 * Merge live and recorded observations into one row per aircraft (latest observation inside the radius wins;
 * live wins ties), sorted by distance ascending. Observations outside the radius are ignored.
 */
export function buildRadiusRows(live: readonly Candidate[], recorded: readonly Candidate[], center: { latitude: number; longitude: number }, radiusNm: number): RadiusRow[] {
  const rows = new Map<string, RadiusRow>();
  const consider = (item: Candidate, origin: RadiusRow["origin"]) => {
    const time = Date.parse(item.observedAt);
    if (!Number.isFinite(time)) return;
    const distance = distanceNm(center.latitude, center.longitude, item.latitude, item.longitude);
    if (distance > radiusNm) return;
    const key = item.icao24.toLowerCase();
    const previous = rows.get(key);
    const previousTime = previous ? Date.parse(previous.observedAt) : -Infinity;
    if (previous && (time < previousTime || (time === previousTime && previous.origin === "live"))) return;
    rows.set(key, {
      icao24: key,
      callsign: item.callsign?.trim() || previous?.callsign || null,
      registration: item.registration?.trim() || previous?.registration || null,
      distanceNm: distance,
      altitudeFt: item.altitudeFt ?? null,
      onGround: item.onGround ?? null,
      groundSpeedKt: item.groundSpeedKt ?? null,
      trackDeg: item.trackDeg ?? null,
      observedAt: new Date(time).toISOString(),
      origin,
      provider: item.provider ?? null,
      latitude: item.latitude,
      longitude: item.longitude,
    });
  };
  for (const item of recorded) consider(item, "recorded");
  for (const item of live) consider(item, "live");
  return [...rows.values()].sort((a, b) => a.distanceNm - b.distanceNm || a.icao24.localeCompare(b.icao24));
}
