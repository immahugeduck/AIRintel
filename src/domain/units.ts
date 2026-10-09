/**
 * Explicit aviation/statute unit conversions and the display formats used by the aircraft lists.
 * Internal values stay in aviation units (nautical miles, knots, feet, UTC ISO timestamps);
 * statute miles and mph exist only at the display edge and in the user-facing radius setting.
 */
export const METERS_PER_NAUTICAL_MILE = 1852;
export const METERS_PER_STATUTE_MILE = 1609.344;
/** 1 knot = 1 NM/h = 1.150779… statute mph. */
export const MPH_PER_KNOT = METERS_PER_NAUTICAL_MILE / METERS_PER_STATUTE_MILE;

export const nmToMiles = (distanceNm: number) => (distanceNm * METERS_PER_NAUTICAL_MILE) / METERS_PER_STATUTE_MILE;
export const milesToNm = (distanceMi: number) => (distanceMi * METERS_PER_STATUTE_MILE) / METERS_PER_NAUTICAL_MILE;
export const milesToMeters = (distanceMi: number) => distanceMi * METERS_PER_STATUTE_MILE;
export const knotsToMph = (speedKt: number) => speedKt * MPH_PER_KNOT;

/** The owner's watch ("netting") radius: 7 statute miles ≈ 6.0828 NM. */
export const WATCH_RADIUS_MI = 7;
export const WATCH_RADIUS_NM = milesToNm(WATCH_RADIUS_MI);
/** Bounds for the user-adjustable radius (statute miles). */
export const MIN_WATCH_RADIUS_MI = 1;
export const MAX_WATCH_RADIUS_MI = 50;

/** A new radius visit starts when an aircraft enters after being outside, or after this long without any observation. */
export const VISIT_GAP_MINUTES = 10;

export const EM_DASH = "—";
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/** "3.2 mi" from nautical miles; em dash when unknown. */
export function formatDistanceMi(distanceNm: number | null | undefined): string {
  return finite(distanceNm) ? `${nmToMiles(distanceNm).toFixed(1)} mi` : EM_DASH;
}

/** "4,200 ft"; "Ground" only when the source reported the aircraft on the ground; em dash when unknown. */
export function formatAltitudeFt(altitudeFt: number | null | undefined, onGround?: boolean | null): string {
  if (onGround === true) return "Ground";
  return finite(altitudeFt) ? `${Math.round(altitudeFt).toLocaleString("en-US")} ft` : EM_DASH;
}

/** "142 mph" from ground speed in knots; em dash when unknown. */
export function formatSpeedMph(groundSpeedKt: number | null | undefined): string {
  return finite(groundSpeedKt) ? `${Math.round(knotsToMph(groundSpeedKt)).toLocaleString("en-US")} mph` : EM_DASH;
}

/**
 * Simple "last seen" stamp in the viewer's local time zone: `10/8/26 @ 4:40pm` (M/D/YY @ h:mmam/pm, no leading zeros).
 * `timeZone` is injectable for deterministic tests; the browser default is the user's zone.
 */
export function formatLastSeen(isoTimestamp: string | null | undefined, timeZone?: string): string {
  if (!isoTimestamp) return EM_DASH;
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    year: "2-digit", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const hour = String(Number(part("hour")) || 12);
  return `${Number(part("month"))}/${Number(part("day"))}/${part("year")} @ ${hour}:${part("minute")}${part("dayPeriod").toLowerCase()}`;
}
