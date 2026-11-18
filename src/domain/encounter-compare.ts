import type { NettedVisit } from "./netted.js";
import { knotsToMph } from "./units.js";

/**
 * Compares one aircraft's encounters with each other (Calculated from the closest-point snapshots, which are Observed).
 * "Typical" is the median over this aircraft's own entries, so a flag means "unusual FOR THIS AIRCRAFT over your
 * location", never a claim about why it flew that way.
 */

export const COMPARE_MIN_ENTRIES = 3;
/** Thresholds in explicit units. */
export const COMPARE_THRESHOLDS = {
  /** Closest distance at or below this fraction of the aircraft's median closest distance. */
  closerFraction: 0.5,
  /** At least this many feet below the aircraft's median altitude at closest point. */
  lowerFt: 1_000,
  /** Stayed inside at least this multiple of its median time inside, and at least `longerMinMinutes`. */
  longerFactor: 2,
  longerMinMinutes: 5,
  /** Lingered: at least this many times the straight-pass time, and at least `lingerMinMinutes` inside. */
  lingerFactor: 3,
  lingerMinMinutes: 5,
  /** Below this ground speed (hover, taxi, missing data) a straight-pass time is not meaningful. */
  straightPassMinSpeedKt: 30,
} as const;

export type PassFlag = "closer" | "lower" | "longer" | "lingered";

export type TypicalPass = {
  /** Entries that have a closest-point snapshot (the only ones compared). */
  entries: number;
  closestMi: number | null;
  altitudeFt: number | null;
  speedMph: number | null;
  minutesInside: number | null;
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Minutes between the first and last observation inside the radius (0 for a single sighting). */
export const minutesInside = (visit: Pick<NettedVisit, "enteredAt" | "lastSeenInRadiusAt">) =>
  Math.max(0, (Date.parse(visit.lastSeenInRadiusAt) - Date.parse(visit.enteredAt)) / 60_000);

/**
 * Time inside the radius as a range (Calculated from Observed timestamps). `atLeast` spans the sightings inside;
 * `atMost` spans the sightings just outside on both sides and is null when either side is Unknown.
 */
export function timeInside(visit: Pick<NettedVisit, "enteredAt" | "lastSeenInRadiusAt" | "enteredAfter" | "exitedBefore">): { atLeast: number; atMost: number | null } {
  const atLeast = minutesInside(visit);
  const atMost = visit.enteredAfter && visit.exitedBefore ? Math.max(atLeast, (Date.parse(visit.exitedBefore) - Date.parse(visit.enteredAfter)) / 60_000) : null;
  return { atLeast, atMost };
}

/**
 * Minutes a straight, constant-speed pass through the circle would take along the chord at the recorded closest
 * distance, at the speed recorded there (Calculated). Null when speed or radius is unknown or the aircraft was slow.
 */
export function straightPassMinutes(visit: NettedVisit, radiusMi: number | null | undefined): number | null {
  const speedKt = visit.closest?.groundSpeedKt;
  if (!radiusMi || speedKt == null || speedKt < COMPARE_THRESHOLDS.straightPassMinSpeedKt) return null;
  const offset = Math.min(visit.closestMi, radiusMi);
  const chordMi = 2 * Math.sqrt(radiusMi * radiusMi - offset * offset);
  return (chordMi / knotsToMph(speedKt)) * 60;
}

const airborneAltitude = (visit: NettedVisit) => (visit.closest && visit.closest.onGround !== true ? visit.closest.altitudeFt : null);

export function typicalPass(visits: readonly NettedVisit[]): TypicalPass {
  const withData = visits.filter((visit) => visit.closest);
  const altitudes = withData.flatMap((visit) => { const a = airborneAltitude(visit); return a === null ? [] : [a]; });
  const speeds = withData.flatMap((visit) => (visit.closest?.groundSpeedKt == null ? [] : [knotsToMph(visit.closest.groundSpeedKt)]));
  return {
    entries: withData.length,
    closestMi: median(withData.map((visit) => visit.closestMi)),
    altitudeFt: median(altitudes),
    speedMph: median(speeds),
    minutesInside: median(withData.map(minutesInside)),
  };
}

/**
 * Flags for one entry. "lingered" compares the entry with a straight pass at its own speed and needs no history; the
 * others compare it with the aircraft's typical pass and start at COMPARE_MIN_ENTRIES entries with data.
 */
export function passFlags(visit: NettedVisit, typical: TypicalPass, radiusMi?: number | null): PassFlag[] {
  if (!visit.closest) return [];
  const T = COMPARE_THRESHOLDS;
  const flags: PassFlag[] = [];
  const straight = straightPassMinutes(visit, visit.radiusMi ?? radiusMi);
  const stayed = minutesInside(visit);
  const lingered = straight !== null && stayed >= T.lingerMinMinutes && stayed >= straight * T.lingerFactor;
  if (typical.entries < COMPARE_MIN_ENTRIES) return lingered ? ["lingered"] : [];
  if (typical.closestMi !== null && typical.closestMi > 0 && visit.closestMi <= typical.closestMi * T.closerFraction) flags.push("closer");
  const altitude = airborneAltitude(visit);
  if (altitude !== null && typical.altitudeFt !== null && altitude <= typical.altitudeFt - T.lowerFt) flags.push("lower");
  const minutes = minutesInside(visit);
  if (typical.minutesInside !== null && minutes >= T.longerMinMinutes && minutes >= typical.minutesInside * T.longerFactor) flags.push("longer");
  if (lingered) flags.push("lingered");
  return flags;
}
