import { z } from "zod";
import { distanceNm } from "./geometry.js";
import { CHARTER_OPERATORS, EDUCATION_OWNER, KNOWN_AIRPORTS, KNOWN_AIRSTRIPS, PATTERN_TIME_ZONE, type KnownAirport, SCHEDULED_OPERATORS, TRAINING_FLEETS } from "./pattern-config.js";

export { CHARTER_OPERATORS, KNOWN_AIRPORTS, KNOWN_AIRSTRIPS, SCHEDULED_OPERATORS, TRAINING_FLEETS } from "./pattern-config.js";

/**
 * Pattern flags (`pattern-flags-v4`; see assessPattern for what changed from v3): a deterministic review-priority score for netted aircraft.
 *
 * What this is: a ranking of RECORDED behavior inside the watch radius (Calculated) plus identity facts (Observed),
 * so that the few aircraft whose behavior is unusual for this area rise to the top of the list for a human to review.
 *
 * What this is NOT: a finding of intent, mission, sensor use or surveillance. Per AGENTS.md, nothing here claims
 * purpose from geometry or ownership. Training aircraft fly "turns around a point" and orbits on purpose; news, survey,
 * medical, police and pipeline-patrol flights all loiter; government registrants include public universities. A high
 * score means "look at this one first", never "this one is watching you". Every reason carries its evidence label.
 *
 * Passes (all deterministic, no AI guesses):
 *   1. Routine explanations: scheduled airline/cargo callsigns, fractional/charter operators, configured local
 *      training fleets (callsign, N-number pattern or FAA owner), circling low over a known airport (traffic pattern),
 *      cruise-altitude transit, steady climb/descent.
 *   2. Behavior inside the radius, from position GEOMETRY (robust to 5 s … 5 min sampling): circling (winding angle
 *      around the visit centroid when sampling follows the turn; otherwise a track confined to a small area while
 *      moving far enough to have looped), orbits centered near the watch center, long dwell, low and slow.
 *   3. Correlation with YOUR locations: the same airframe logged at two of your watch centers ≥ 20 NM apart within a
 *      few hours (you moved, it was there too). Sightings at separate places months apart barely count.
 *   4. Control comparison: days the airframe was also seen in your fixed control circles.
 *   Plus identity signals (adsb.lol database flags, FAA owner type, rotorcraft), recurrence across local days and
 *   identity gaps. Aircraft with too few recorded positions get "insufficient" (not enough data) instead of a guess,
 *   and can never reach "priority" on identity facts alone.
 */
export const PATTERN_ALGORITHM_VERSION = "pattern-flags-v5";

export type PatternPosition = {
  observedAt: string;
  latitude: number;
  longitude: number;
  altitudeFt: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  verticalRateFpm: number | null;
  /** Provider's on-ground state as recorded (Observed); null/absent when unknown. */
  onGround?: boolean | null | undefined;
};

export type CenterMode = "follow" | "fixed";

export type PatternVisit = {
  enteredAt: string;
  lastSeenInRadiusAt: string;
  /** Watch center this visit was measured against; null when unknown. */
  center: { latitude: number; longitude: number } | null;
  /** Recorded positions during the visit, any order. May be empty (sparse sweeps). */
  positions: PatternPosition[];
  /** True when the loader evenly thinned a long visit's positions. */
  downsampled?: boolean | undefined;
};

/** One saved encounter: when it started and which watch center it was measured against (log scope). */
export type PatternSighting = { enteredAt: string; latitude: number; longitude: number; centerMode?: CenterMode | null | undefined };

/** Identity facts from the provider database and the FAA registry. All optional. */
export type PatternIdentity = {
  /** adsb.lol `dbFlags` bitfield: 1 military, 2 interesting, 4 PIA, 8 LADD. */
  dbFlags?: number | null | undefined;
  /** ADS-B emitter category (A7 = rotorcraft). */
  category?: string | null | undefined;
  /** FAA registrant kind as imported (`business` / `government` / `individual` / `other` / `unknown`). */
  registrantKind?: string | null | undefined;
  /** FAA registrant name (business and government registrants only; individuals are redacted on import). */
  registrantName?: string | null | undefined;
  /** FAA TYPE AIRCRAFT code ("6" = rotorcraft). */
  faaAircraftType?: string | null | undefined;
};

export type PatternInput = {
  icao24: string;
  callsign: string | null;
  registration: string | null;
  /** FAA N-number from an exact Mode-S match when the aircraft broadcast none. */
  registryRegistration?: string | null | undefined;
  aircraftTypeCode: string | null;
  /** Lifetime (log) or window visit count. */
  visitCount: number;
  /** Newest visits with positions (bounded by the caller). */
  visits: PatternVisit[];
  /** Every saved encounter's start time and center (log scope); empty in window scope. */
  sightings: PatternSighting[];
  /** Control-circle comparison (log scope). Absent when the user has no swept control circle. */
  control?: { activeCircles: number; daysAtControls: number } | undefined;
  identity?: PatternIdentity | undefined;
  /** Airstrips in addition to KNOWN_AIRSTRIPS (tests, future per-user settings). */
  extraAirstrips?: readonly KnownAirport[] | undefined;
  /** IANA zone used to count days. Defaults to PATTERN_TIME_ZONE. */
  timeZone?: string | undefined;
};

export const patternEvidenceSchema = z.enum(["Observed", "Calculated", "Supported inference", "Unknown"]);
export const patternReasonSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  evidence: patternEvidenceSchema,
  /** Positive raises review priority; negative is a routine explanation. */
  weight: z.number().finite(),
});
export const patternTierSchema = z.enum(["priority", "review", "low", "insufficient", "routine"]);
export const patternAssessmentSchema = z.object({
  version: z.string().min(1),
  tier: patternTierSchema,
  score: z.number().finite(),
  /** Short routine explanation when tier is "routine" (e.g. "LIFT Academy training fleet"). */
  explainedBy: z.string().nullable(),
  reasons: z.array(patternReasonSchema),
  /** "ok": ≥ 2 visits with enough positions to judge; "limited": 1; "sparse": none. */
  coverage: z.enum(["ok", "limited", "sparse"]),
  /** Who/what the aircraft is (training fleet, charter, mostly airport traffic), shown at every tier. v4+. */
  context: z.string().nullish(),
  /** Whether that context covers the recorded behavior. null = no context or a scheduled flight number. v4+. */
  fit: z.enum(["consistent", "not_explained"]).nullish(),
});
export type PatternReason = z.infer<typeof patternReasonSchema>;
export type PatternTier = z.infer<typeof patternTierSchema>;
export type PatternAssessment = z.infer<typeof patternAssessmentSchema>;

/** Thresholds in explicit units. Tuned for a ~7 mi radius and 1–5 minute sampling. */
export const PATTERN_THRESHOLDS = {
  loiterMinutes: 15,
  circlingTurnDeg: 300,
  orbitCenterNm: 2,
  lowAltitudeFt: 6_000,
  slowGroundSpeedKt: 140,
  cruiseAltitudeFt: 10_000,
  climbDescentFpm: 500,
  /** A visit is judged only with at least this many positions spanning at least `assessableMinutes`. */
  minPositions: 3,
  assessableMinutes: 3,
  /** Consecutive bearing steps (around the centroid) above this are ambiguous: the turn is undersampled. */
  windingMaxStepDeg: 120,
  windingMaxSpreadNm: 3,
  /** Confined-track rule (works at any sampling rate): stayed within this spread while flying far enough to loop. */
  confinedMinMinutes: 5,
  confinedMaxSpreadNm: 2.5,
  confinedMinTravelNm: 3,
  minCirclingSpeedKt: 40,
  /** Circling within this distance of a known airport, below field elevation + `airportPatternAglFt`, is pattern work. */
  airportPatternNm: 3,
  airportPatternAglFt: 2_500,
  /**
   * Two watch centers count as separate places only when circles of the default 7 mi (6.1 NM) radius cannot overlap,
   * with margin. Closer centers let one straight pass (e.g. an airliner at cruise) register at "both" places.
   */
  separateCentersNm: 20,
  /** Same airframe at two separate places of yours within this many hours = "followed locations". */
  followWindowHours: 6,
  recurrenceVisits: 5,
  recurrenceDays: 3,
  controlCommonDays: 2,
  controlAbsentYourDays: 3,
  /** v5: consecutive local days seen with the radius on your phone (follow mode). */
  streakDays: 5,
  streakStrongDays: 7,
  /** v5: "dip" = drop in altitude and/or ground speed once inside this distance of the watch center, then recovery. */
  dipRadiusNm: 1.74, // 2 statute miles
  dipAltitudeFt: 300,
  dipSpeedKt: 15,
  /** Recovered at least this fraction of the drop after leaving the 2 mi zone (otherwise it is a descent, not a dip). */
  dipRecoveryFraction: 0.5,
  /** v5: another entry the same local day at least this many hours after the previous one. */
  repeatGapHours: 2,
  repeatStrongDays: 3,
  /** A dip whose low point is within this distance of a known airport or airstrip is "near a field". */
  airstripNm: 1,
  /** Near a field, a low point at most this far above field elevation is read as a touch-and-go / low approach. */
  touchAndGoAglFt: 100,
  /** Weight of each near-field dip (max `nearFieldDipMax`): ambiguous, so counted but lightly. */
  nearFieldDipWeight: 0.5,
  nearFieldDipMax: 1.5,
  priorityScore: 7,
  reviewScore: 4,
} as const;

const OPERATOR_CALLSIGN = /^([A-Z]{3})(\d{1,4}[A-Z]{0,2})$/;

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Signed smallest heading change from a to b, degrees in (-180, 180]. */
export function headingDelta(a: number, b: number): number {
  let delta = ((b - a) % 360 + 540) % 360 - 180;
  if (delta === -180) delta = 180;
  return delta;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
/** Calendar day (YYYY-MM-DD) of an instant in `timeZone`. */
export function localDay(iso: string, timeZone: string = PATTERN_TIME_ZONE): string {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(iso));
}

export type CirclingEvidence = {
  /** Enough positions over enough time to judge this visit at all. */
  assessable: boolean;
  circling: boolean;
  method: "winding" | "confined" | null;
  /** Winding angle (winding) or estimated turning from distance flown (confined), degrees. */
  turnDeg: number;
  /** Largest distance of any position from the visit centroid. */
  spreadNm: number;
  /** Distance flown during the visit (median ground speed x duration). */
  travelNm: number;
  minutes: number;
  samples: number;
  centroid: { latitude: number; longitude: number } | null;
  medianAltitudeFt: number | null;
};

/**
 * Circling from position geometry (Calculated). Two independent tests, so the result does not depend on the sampling
 * rate lining up with the turn rate:
 *  - winding: bearing of each position as seen from the visit centroid; when every step is under
 *    `windingMaxStepDeg` the sampling follows the turn and the summed bearing change is the turning angle;
 *  - confined: the aircraft moved at ≥ `minCirclingSpeedKt` for ≥ `confinedMinMinutes` yet never left a small area.
 *    Flying far enough to have looped around that area (≥ 2π·spread) is only possible by turning back, which is
 *    what undersampled orbits (e.g. a 2-minute orbit seen every 5 minutes) look like.
 */
export function circlingEvidence(positions: readonly PatternPosition[]): CirclingEvidence {
  const T = PATTERN_THRESHOLDS;
  const points = positions
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Number.isFinite(Date.parse(p.observedAt)))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const samples = points.length;
  const minutes = samples > 1 ? (Date.parse(points[samples - 1]!.observedAt) - Date.parse(points[0]!.observedAt)) / 60_000 : 0;
  const altitudes = points.flatMap((p) => (p.altitudeFt === null ? [] : [p.altitudeFt]));
  const empty: CirclingEvidence = { assessable: false, circling: false, method: null, turnDeg: 0, spreadNm: 0, travelNm: 0, minutes, samples, centroid: null, medianAltitudeFt: median(altitudes) };
  if (samples < T.minPositions || minutes < T.assessableMinutes) return empty;

  const centroid = { latitude: points.reduce((s, p) => s + p.latitude, 0) / samples, longitude: points.reduce((s, p) => s + p.longitude, 0) / samples };
  const spreadNm = Math.max(...points.map((p) => distanceNm(centroid.latitude, centroid.longitude, p.latitude, p.longitude)));
  let speedKt = median(points.flatMap((p) => (p.groundSpeedKt === null ? [] : [p.groundSpeedKt])));
  if (speedKt === null) {
    let path = 0;
    for (let i = 1; i < samples; i += 1) path += distanceNm(points[i - 1]!.latitude, points[i - 1]!.longitude, points[i]!.latitude, points[i]!.longitude);
    speedKt = minutes > 0 ? path / (minutes / 60) : 0;
  }
  const travelNm = speedKt * (minutes / 60);
  const result: CirclingEvidence = { ...empty, assessable: true, spreadNm, travelNm, centroid };

  // Winding angle around the centroid (local flat projection is fine at these distances).
  const cosLat = Math.cos((centroid.latitude * Math.PI) / 180);
  const bearings = points.map((p) => (Math.atan2((p.longitude - centroid.longitude) * cosLat, p.latitude - centroid.latitude) * 180) / Math.PI);
  let winding = 0;
  let wellSampled = spreadNm > 0.05;
  for (let i = 1; i < bearings.length && wellSampled; i += 1) {
    const step = headingDelta(bearings[i - 1]!, bearings[i]!);
    if (Math.abs(step) > T.windingMaxStepDeg) wellSampled = false;
    winding += step;
  }
  if (wellSampled && Math.abs(winding) >= T.circlingTurnDeg && spreadNm <= T.windingMaxSpreadNm && speedKt >= T.minCirclingSpeedKt) {
    return { ...result, circling: true, method: "winding", turnDeg: Math.abs(winding) };
  }

  const loopNm = 2 * Math.PI * Math.max(spreadNm, 0.25);
  if (minutes >= T.confinedMinMinutes && speedKt >= T.minCirclingSpeedKt && spreadNm <= T.confinedMaxSpreadNm && travelNm >= Math.max(T.confinedMinTravelNm, loopNm)) {
    return { ...result, circling: true, method: "confined", turnDeg: (travelNm / loopNm) * 360 };
  }
  return { ...result, turnDeg: wellSampled ? Math.abs(winding) : 0 };
}

const visitMinutes = (visit: PatternVisit) => (Date.parse(visit.lastSeenInRadiusAt) - Date.parse(visit.enteredAt)) / 60_000;

/** Clusters watch centers that are within `separateCentersNm` of each other. Returns the number of separate places. */
export function countSeparateCenters(centers: readonly { latitude: number; longitude: number }[], separationNm: number = PATTERN_THRESHOLDS.separateCentersNm): number {
  const clusters: { latitude: number; longitude: number }[] = [];
  for (const center of centers) {
    if (!clusters.some((c) => distanceNm(c.latitude, c.longitude, center.latitude, center.longitude) < separationNm)) clusters.push(center);
  }
  return clusters.length;
}

/**
 * Time-aware location correlation: pairs of sightings at watch centers ≥ `separateCentersNm` apart that started within
 * `followWindowHours` of each other. Returns how many sightings had such a partner, on how many local days, the
 * largest separation, and the number of separate places overall.
 */
export function timeCorrelatedPlaces(sightings: readonly PatternSighting[], timeZone: string = PATTERN_TIME_ZONE): { pairs: number; days: number; maxSeparationNm: number; places: number } {
  const T = PATTERN_THRESHOLDS;
  const sorted = [...sightings].filter((s) => Number.isFinite(Date.parse(s.enteredAt))).sort((a, b) => Date.parse(a.enteredAt) - Date.parse(b.enteredAt));
  const windowMs = T.followWindowHours * 3_600_000;
  let pairs = 0;
  let maxSeparationNm = 0;
  const days = new Set<string>();
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length && Date.parse(sorted[j]!.enteredAt) - Date.parse(a.enteredAt) <= windowMs; j += 1) {
      const b = sorted[j]!;
      const separation = distanceNm(a.latitude, a.longitude, b.latitude, b.longitude);
      if (separation >= T.separateCentersNm) {
        pairs += 1;
        maxSeparationNm = Math.max(maxSeparationNm, separation);
        days.add(localDay(b.enteredAt, timeZone));
        break;
      }
    }
  }
  return { pairs, days: days.size, maxSeparationNm, places: countSeparateCenters(sorted) };
}

type RoutineMatch = { code: string; label: string; evidence: PatternReason["evidence"] };

export function routineExplanation(input: { callsign: string | null; registration: string | null; registryRegistration?: string | null | undefined; registrantName?: string | null | undefined }): RoutineMatch | null {
  const callsign = input.callsign?.trim().toUpperCase() ?? "";
  const registrations = [input.registration, input.registryRegistration].flatMap((r) => (r?.trim() ? [r.trim().toUpperCase()] : []));
  const owner = input.registrantName?.trim().toUpperCase() ?? "";
  const match = OPERATOR_CALLSIGN.exec(callsign);
  const designator = match?.[1] ?? null;
  for (const fleet of TRAINING_FLEETS) {
    const byCallsign = fleet.callsignDesignator !== undefined && designator === fleet.callsignDesignator;
    const byRegistration = fleet.registration !== undefined && registrations.some((r) => fleet.registration!.test(r));
    const byOwner = fleet.owner !== undefined && owner.length > 0 && fleet.owner.test(owner);
    if (byCallsign || byRegistration || byOwner) {
      return { code: "training_fleet", label: fleet.label, evidence: byOwner ? "Observed" : "Supported inference" };
    }
  }
  if (designator) {
    if (SCHEDULED_OPERATORS[designator]) return { code: "scheduled_operator", label: `${SCHEDULED_OPERATORS[designator]} flight number`, evidence: "Observed" };
    if (CHARTER_OPERATORS[designator]) return { code: "charter_operator", label: `${CHARTER_OPERATORS[designator]} (fractional/charter jet)`, evidence: "Observed" };
  }
  return null;
}

/** Known airport whose traffic pattern explains circling at this centroid and altitude, if any. */
export function airportPatternAt(centroid: { latitude: number; longitude: number }, medianAltitudeFt: number | null): string | null {
  const T = PATTERN_THRESHOLDS;
  for (const airport of KNOWN_AIRPORTS) {
    if (distanceNm(airport.latitude, airport.longitude, centroid.latitude, centroid.longitude) > T.airportPatternNm) continue;
    if (medianAltitudeFt !== null && medianAltitudeFt > airport.elevationFt + T.airportPatternAglFt) continue;
    return airport.id;
  }
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Longest run of consecutive local days in a set of YYYY-MM-DD strings. */
export function longestDayStreak(days: Iterable<string>): number {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of sorted) {
    const at = Date.parse(`${day}T12:00:00Z`);
    run = previous !== null && Math.round((at - previous) / 86_400_000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = at;
  }
  return best;
}

/**
 * Sightings counted for the "follows your phone" checks: follow-mode sightings when any are tagged, otherwise all
 * (mode unknown on older records). Fixed-center sightings are left out when follow-mode ones exist.
 */
export function phoneSightings(sightings: readonly PatternSighting[]): { list: PatternSighting[]; modeKnown: boolean } {
  const follow = sightings.filter((s) => s.centerMode === "follow");
  return follow.length > 0 ? { list: follow, modeKnown: true } : { list: [...sightings], modeKnown: false };
}

/** Local days with another entry at least `repeatGapHours` after the previous entry that day. */
export function sameDayRepeatDays(entries: readonly string[], timeZone: string = PATTERN_TIME_ZONE): { days: number; maxEntriesInDay: number } {
  const gapMs = PATTERN_THRESHOLDS.repeatGapHours * 3_600_000;
  const byDay = new Map<string, number[]>();
  for (const at of entries) {
    const ms = Date.parse(at);
    if (!Number.isFinite(ms)) continue;
    const day = localDay(at, timeZone);
    byDay.set(day, [...(byDay.get(day) ?? []), ms]);
  }
  let days = 0;
  let maxEntriesInDay = 0;
  for (const times of byDay.values()) {
    times.sort((a, b) => a - b);
    let spaced = 1;
    for (let i = 1; i < times.length; i += 1) if (times[i]! - times[i - 1]! >= gapMs) spaced += 1;
    if (spaced >= 2) {
      days += 1;
      maxEntriesInDay = Math.max(maxEntriesInDay, spaced);
    }
  }
  return { days, maxEntriesInDay };
}

export type DipLowPoint = { latitude: number; longitude: number; altitudeFt: number | null; /** The provider reported on-ground during this traversal (recorded flag, not inferred). */ onGround: boolean };
export type DipEvidence = {
  assessable: boolean; altitudeChecked: boolean; speedChecked: boolean; altitudeDropFt: number; speedDropKt: number; altitudeDip: boolean; speedDip: boolean;
  /** Lowest-altitude position (or slowest, for a speed-only dip) of the deepest dipping traversal; null without a dip. */
  lowPoint: DipLowPoint | null;
};

/**
 * Dip near the watch center (Calculated): compares the last positions before entering 2 mi of the center, the lowest
 * altitude / speed inside 2 mi, and the first positions after leaving. A drop that does not recover is a descent
 * (arrival), not a dip. Needs positions on both sides of the 2 mi zone; otherwise "not assessable" (Unknown).
 */
export function dipEvidence(visit: PatternVisit): DipEvidence {
  const T = PATTERN_THRESHOLDS;
  const none: DipEvidence = { assessable: false, altitudeChecked: false, speedChecked: false, altitudeDropFt: 0, speedDropKt: 0, altitudeDip: false, speedDip: false, lowPoint: null };
  if (!visit.center) return none;
  const c = visit.center;
  const points = visit.positions
    .filter((p) => Number.isFinite(Date.parse(p.observedAt)))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
    .map((p) => ({ p, inside: distanceNm(c.latitude, c.longitude, p.latitude, p.longitude) <= T.dipRadiusNm }));
  // Each traversal of the 2 mi zone is judged on its own: "before" and "after" samples stop at the zone boundary, so a
  // second pass through the zone never counts as recovery from the first.
  const result: DipEvidence = { ...none };
  let deepestDropFt = -Infinity;
  let i = 0;
  while (i < points.length) {
    if (!points[i]!.inside) { i += 1; continue; }
    const first = i;
    let last = first;
    while (last + 1 < points.length && points[last + 1]!.inside) last += 1;
    i = last + 1;
    if (first === 0 || last + 1 >= points.length) continue;
    const before: PatternPosition[] = [];
    for (let j = first - 1; j >= 0 && !points[j]!.inside && before.length < 3; j -= 1) before.unshift(points[j]!.p);
    const after: PatternPosition[] = [];
    for (let j = last + 1; j < points.length && !points[j]!.inside && after.length < 3; j += 1) after.push(points[j]!.p);
    const inside = points.slice(first, last + 1).map((x) => x.p);
    const measure = (key: "altitudeFt" | "groundSpeedKt", threshold: number) => {
      const b = median(before.flatMap((p) => (p[key] === null ? [] : [p[key]!])));
      const lows = inside.flatMap((p) => (p[key] === null ? [] : [p[key]!]));
      const a = median(after.flatMap((p) => (p[key] === null ? [] : [p[key]!])));
      if (b === null || a === null || lows.length === 0) return { drop: 0, dip: false, known: false };
      const low = Math.min(...lows);
      const drop = b - low;
      return { drop, dip: drop >= threshold && a - low >= drop * T.dipRecoveryFraction, known: true };
    };
    const alt = measure("altitudeFt", T.dipAltitudeFt);
    const spd = measure("groundSpeedKt", T.dipSpeedKt);
    result.assessable = result.assessable || alt.known || spd.known;
    result.altitudeChecked = result.altitudeChecked || alt.known;
    result.speedChecked = result.speedChecked || spd.known;
    result.altitudeDropFt = Math.max(result.altitudeDropFt, alt.drop);
    result.speedDropKt = Math.max(result.speedDropKt, spd.drop);
    if ((alt.dip || spd.dip) && (alt.drop > deepestDropFt || result.lowPoint === null)) {
      deepestDropFt = alt.drop;
      const withAlt = inside.filter((p) => p.altitudeFt !== null);
      const pick = alt.dip && withAlt.length > 0
        ? withAlt.reduce((lo, p) => (p.altitudeFt! < lo.altitudeFt! ? p : lo))
        : inside.filter((p) => p.groundSpeedKt !== null).reduce((lo, p) => (p.groundSpeedKt! < lo.groundSpeedKt! ? p : lo));
      result.lowPoint = { latitude: pick.latitude, longitude: pick.longitude, altitudeFt: pick.altitudeFt, onGround: inside.some((p) => p.onGround === true) };
    }
    result.altitudeDip = result.altitudeDip || alt.dip;
    result.speedDip = result.speedDip || spd.dip;
  }
  return result;
}

export type DipContext = { kind: "touch_and_go"; field: string | null; onGround: boolean } | { kind: "near_field"; field: string } | { kind: "open" };

/**
 * What a dip's low point was near (Supported inference). The provider's recorded on-ground flag during the traversal, or within `touchAndGoAglFt` of a
 * known field's elevation within `airstripNm`: touch-and-go / low approach. Within `airstripNm` of a field but higher:
 * near a field (ambiguous). Otherwise: open country. GPS altitude is height above the WGS-84 ellipsoid, which reads
 * roughly 50–115 ft below sea-level altitude in the US, so "within 100 ft" can include low passes up to ~200 ft.
 */
export function dipContext(low: DipLowPoint, extraFields: readonly KnownAirport[] = []): DipContext {
  const T = PATTERN_THRESHOLDS;
  if (low.onGround) return { kind: "touch_and_go", field: null, onGround: true };
  let nearest: { id: string; elevationFt: number; nm: number } | null = null;
  for (const field of [...extraFields, ...KNOWN_AIRSTRIPS, ...KNOWN_AIRPORTS]) {
    const nm = distanceNm(field.latitude, field.longitude, low.latitude, low.longitude);
    if (nm <= T.airstripNm && (!nearest || nm < nearest.nm)) nearest = { id: field.id, elevationFt: field.elevationFt, nm };
  }
  if (!nearest) return { kind: "open" };
  if (low.altitudeFt !== null && low.altitudeFt - nearest.elevationFt <= T.touchAndGoAglFt) return { kind: "touch_and_go", field: nearest.id, onGround: false };
  return { kind: "near_field", field: nearest.id };
}

/** Known airport whose traffic area explains a visit (centroid of its positions near the field, at pattern height). */
export function visitAirport(visit: PatternVisit, geometry: CirclingEvidence): string | null {
  const points = visit.positions.filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
  if (points.length === 0) return null;
  const centroid = geometry.centroid ?? { latitude: points.reduce((s, p) => s + p.latitude, 0) / points.length, longitude: points.reduce((s, p) => s + p.longitude, 0) / points.length };
  const altitudes = points.flatMap((p) => (p.altitudeFt === null ? [] : [p.altitudeFt]));
  return airportPatternAt(centroid, geometry.medianAltitudeFt ?? median(altitudes));
}

/**
 * Pure, deterministic assessment of one netted aircraft (`pattern-flags-v4`).
 *
 * v4 principle: score BEHAVIOR; treat WHO the aircraft is as context that must fit what it did.
 *  - Training-fleet and charter labels lower the score (−3) but no longer force "routine". Behavior the label does not
 *    explain (showing up at your separate locations within hours, orbits centered on your watch center away from any
 *    airport, absence from your control circles) keeps full weight, and `fit` reports "not_explained".
 *  - Airport explanations are judged per visit: visits flown within 3 NM of a known field at pattern height are
 *    "airport area" (takeoffs, landings, pattern work) and their circling/loitering/low-slow is not scored; visits
 *    elsewhere are scored normally. One explained visit no longer excuses the rest, and vice versa.
 *  - Only published scheduled/cargo flight numbers still force "routine".
 */
export function assessPattern(input: PatternInput): PatternAssessment {
  const T = PATTERN_THRESHOLDS;
  const timeZone = input.timeZone ?? PATTERN_TIME_ZONE;
  const identity = input.identity ?? {};
  const reasons: PatternReason[] = [];
  const allPositions = input.visits.flatMap((visit) => visit.positions);
  const allAltitudes = allPositions.flatMap((p) => (p.altitudeFt === null ? [] : [p.altitudeFt]));
  const verticals = allPositions.flatMap((p) => (p.verticalRateFpm === null ? [] : [p.verticalRateFpm]));
  const overallAltitudeFt = median(allAltitudes);

  // Geometry and airport area per visit.
  const evidence = input.visits.map((visit) => {
    const geometry = circlingEvidence(visit.positions);
    return { visit, geometry, airport: visitAirport(visit, geometry) };
  });
  const assessable = evidence.filter((e) => e.geometry.assessable).length;
  const positioned = evidence.filter((e) => e.visit.positions.length > 0);
  const airportVisits = positioned.filter((e) => e.airport !== null);
  const away = evidence.filter((e) => e.airport === null);
  const mostlyAirport = positioned.length > 0 && airportVisits.length * 2 >= positioned.length;

  // Pass 1: context (labels and profiles).
  const label: RoutineMatch | null = routineExplanation({ callsign: input.callsign, registration: input.registration, registryRegistration: input.registryRegistration, registrantName: identity.registrantName });
  const scheduled = label?.code === "scheduled_operator";
  const training = label?.code === "training_fleet";
  const charter = label?.code === "charter_operator";
  if (label) reasons.push({ ...label, label: scheduled ? label.label : `${label.label} (context: lowers the score, does not excuse unexplained behavior)`, weight: scheduled ? -4 : -3 });
  if (airportVisits.length > 0) {
    const ids = [...new Set(airportVisits.map((e) => e.airport as string))].join(", ");
    reasons.push({
      code: "airport_area",
      label: `${airportVisits.length} of ${positioned.length} recorded visits were within ${T.airportPatternNm} NM of ${ids} at pattern height (takeoffs, landings, traffic pattern); behavior on those visits is not scored`,
      evidence: "Supported inference",
      weight: mostlyAirport ? -3 : -1,
    });
  }
  if (overallAltitudeFt !== null && overallAltitudeFt >= T.cruiseAltitudeFt) {
    reasons.push({ code: "cruise_transit", label: `Passing through at cruise altitude (median ${Math.round(overallAltitudeFt).toLocaleString("en-US")} ft)`, evidence: "Calculated", weight: -3 });
  }
  if (verticals.length >= 3 && verticals.filter((v) => Math.abs(v) >= T.climbDescentFpm).length / verticals.length >= 0.6) {
    reasons.push({ code: "climb_descent", label: "Climbing or descending steadily through the radius (arrival/departure profile)", evidence: "Calculated", weight: -2 });
  }
  const transit = reasons.some((r) => r.code === "cruise_transit");

  // Pass 2: behavior inside the radius, only from visits NOT explained by an airport area.
  const circlingVisits = away.filter((e) => e.geometry.circling);
  let centeredCount = 0;
  if (circlingVisits.length > 0) {
    const maxTurn = Math.max(...circlingVisits.map((e) => e.geometry.turnDeg));
    const estimated = circlingVisits.every((e) => e.geometry.method === "confined");
    reasons.push({
      code: "circling",
      label: `Circled away from any known airport on ${plural(circlingVisits.length, "visit")} (${estimated ? "about " : "up to "}${Math.round(maxTurn).toLocaleString("en-US")}° of turn${estimated ? ", estimated from distance flown in a small area" : ""})${training ? "; turns around a point are a normal training maneuver" : ""}`,
      evidence: "Calculated",
      weight: training ? 1 : 3,
    });
    centeredCount = circlingVisits.filter((e) => e.visit.center && distanceNm(e.visit.center.latitude, e.visit.center.longitude, e.geometry.centroid!.latitude, e.geometry.centroid!.longitude) <= T.orbitCenterNm).length;
    if (centeredCount > 0) reasons.push({ code: "centered_orbit", label: `Orbit centered within ${T.orbitCenterNm} NM of your watch center, away from any airport, on ${plural(centeredCount, "visit")}`, evidence: "Calculated", weight: centeredCount >= 2 ? 3 : 2 });
  }
  const longVisits = away.filter((e) => visitMinutes(e.visit) >= T.loiterMinutes).map((e) => e.visit);
  if (longVisits.length > 0) {
    const longest = Math.round(Math.max(...longVisits.map(visitMinutes)));
    reasons.push({ code: "loiter", label: `Stayed inside the radius ${T.loiterMinutes}+ min away from any airport on ${plural(longVisits.length, "visit")} (longest ${longest} min)`, evidence: "Calculated", weight: training ? 1 : longVisits.length >= 3 ? 3 : 2 });
  }
  const awayPositions = away.flatMap((e) => e.visit.positions);
  const awayAltitudeFt = median(awayPositions.flatMap((p) => (p.altitudeFt === null ? [] : [p.altitudeFt])));
  const awaySpeedKt = median(awayPositions.flatMap((p) => (p.groundSpeedKt === null ? [] : [p.groundSpeedKt])));
  if (awayPositions.length >= T.minPositions && awayAltitudeFt !== null && awaySpeedKt !== null && awayAltitudeFt <= T.lowAltitudeFt && awaySpeedKt <= T.slowGroundSpeedKt) {
    reasons.push({ code: "low_slow", label: `Low and slow away from airports (median ${Math.round(awayAltitudeFt).toLocaleString("en-US")} ft, ${Math.round(awaySpeedKt)} kt)${training ? "; normal for a trainer" : ""}`, evidence: "Calculated", weight: training ? 0 : 1 });
  }

  // Pass 3: time-aware correlation with the user's own watch centers. No label explains this.
  const places = timeCorrelatedPlaces(input.sightings, timeZone);
  const followed = !transit && places.pairs > 0;
  if (followed) {
    reasons.push({ code: "followed_locations", label: `Logged at your watch locations ${Math.round(places.maxSeparationNm)} NM apart within ${T.followWindowHours} h (${plural(places.days, "day")})`, evidence: "Calculated", weight: places.days >= 2 ? 5 : 4 });
  } else if (!transit && places.places >= 2) {
    reasons.push({ code: "separate_places", label: `Logged at ${places.places} of your locations ≥ ${T.separateCentersNm} NM apart, but not within ${T.followWindowHours} h of each other`, evidence: "Calculated", weight: 1 });
  }

  // Identity signals.
  const flags = typeof identity.dbFlags === "number" && Number.isFinite(identity.dbFlags) ? identity.dbFlags : 0;
  if (flags & 1) reasons.push({ code: "military_flag", label: "Listed as military in the adsb.lol aircraft database", evidence: "Supported inference", weight: 2 });
  if (flags & 4) reasons.push({ code: "privacy_address", label: "Broadcasts an FAA Privacy ICAO Address (PIA): the public registry does not show the operator", evidence: "Observed", weight: 1 });
  if (flags & 8) reasons.push({ code: "ladd", label: "On the FAA LADD list (owner limits public flight tracking; common for business and private aircraft)", evidence: "Observed", weight: 1 });
  const owner = identity.registrantName?.trim().toUpperCase() ?? "";
  if (identity.registrantKind === "government" && !EDUCATION_OWNER.test(owner)) {
    reasons.push({ code: "government_owner", label: owner ? `FAA registrant is a government body (${owner})` : "FAA registrant type: government", evidence: "Observed", weight: 2 });
  }
  const rotorcraft = identity.category?.trim().toUpperCase() === "A7" || identity.faaAircraftType?.trim().toUpperCase() === "6";
  if (rotorcraft && (circlingVisits.length > 0 || longVisits.length > 0)) {
    reasons.push({ code: "rotorcraft_loiter", label: "Helicopter circling or loitering (news, medical, police and utility helicopters all do this)", evidence: "Supported inference", weight: 1 });
  }

  const days = new Set(input.visits.map((visit) => localDay(visit.enteredAt, timeZone))).size;

  // Pass 4: comparison with the user's control circles (the empirical baseline).
  let controlAbsent = false;
  if (input.control && input.control.activeCircles > 0) {
    const atControls = input.control.daysAtControls;
    const circles = input.control.activeCircles === 1 ? "your control circle" : "your control circles";
    if (atControls >= T.controlCommonDays && atControls * 2 >= days) {
      reasons.push({ code: "control_common", label: `Also seen at ${circles} on ${atControls} days: common local traffic, not specific to you`, evidence: "Calculated", weight: -2 });
    } else if (atControls === 0 && days >= T.controlAbsentYourDays) {
      controlAbsent = true;
      reasons.push({ code: "control_absent", label: `Seen near you on ${days} days but never at ${circles}`, evidence: "Calculated", weight: 1 });
    }
  }
  if (input.visitCount >= T.recurrenceVisits && days >= T.recurrenceDays) {
    const recurrenceWeight = scheduled || mostlyAirport ? 0 : training || charter ? 1 : 2;
    reasons.push({ code: "recurrence", label: `${input.visitCount} entries, on ${days}+ local days${mostlyAirport ? " (mostly airport traffic)" : ""}`, evidence: "Observed", weight: recurrenceWeight });
  }
  // v5: consecutive days with the radius on your phone.
  const phone = phoneSightings(input.sightings.length > 0 ? input.sightings : input.visits.map((v) => ({ enteredAt: v.enteredAt, latitude: v.center?.latitude ?? 0, longitude: v.center?.longitude ?? 0, centerMode: null })));
  const where = phone.modeKnown ? "with the radius on your phone" : "(watch-center mode not recorded)";
  const streak = longestDayStreak(phone.list.map((s) => localDay(s.enteredAt, timeZone)));
  const damped = training || charter || mostlyAirport;
  if (streak >= T.streakDays && !scheduled) {
    reasons.push({ code: "consecutive_days", label: `Seen ${streak} days in a row ${where}${damped ? " (expected for local/airport traffic)" : ""}`, evidence: "Observed", weight: damped ? 1 : streak >= T.streakStrongDays ? 3 : 2 });
  }

  // v5: separate passes hours apart on the same day.
  const repeats = sameDayRepeatDays(phone.list.map((s) => s.enteredAt), timeZone);
  if (repeats.days > 0 && !scheduled) {
    reasons.push({
      code: "same_day_repeat",
      label: `Came back ${T.repeatGapHours}+ h after its previous pass on ${plural(repeats.days, "day")} (up to ${repeats.maxEntriesInDay} spaced passes in one day) ${where}`,
      evidence: "Observed",
      weight: damped ? (repeats.days >= T.repeatStrongDays ? 1 : 0) : repeats.days >= T.repeatStrongDays ? 2 : 1,
    });
  }

  // v5: dips in altitude/speed inside 2 mi of the watch center (airport-area visits excluded: approaches descend).
  const dips = away.map((e) => dipEvidence(e.visit));
  const dipAssessable = dips.filter((d) => d.assessable).length;
  const dipped = dips.filter((d) => d.altitudeDip || d.speedDip).map((d) => ({ d, where: dipContext(d.lowPoint!, input.extraAirstrips) }));
  const touchAndGo = dipped.filter((x) => x.where.kind === "touch_and_go");
  const nearField = dipped.filter((x) => x.where.kind === "near_field");
  const anyDips = dipped.filter((x) => x.where.kind === "open").map((x) => x.d);
  const bothDips = anyDips.filter((d) => d.altitudeDip && d.speedDip);
  if (touchAndGo.length > 0) {
    const fields = [...new Set(touchAndGo.flatMap((x) => (x.where.kind === "touch_and_go" && x.where.field ? [x.where.field] : [])))];
    const onGround = touchAndGo.some((x) => x.where.kind === "touch_and_go" && x.where.onGround);
    reasons.push({
      code: "touch_and_go",
      label: `${plural(touchAndGo.length, "dip")} went down to ${onGround ? "the ground (provider reported on-ground)" : `within ${T.touchAndGoAglFt} ft of field elevation`}${fields.length ? ` at ${fields.join(", ")}` : ""}: touch-and-go or low approach, not scored`,
      evidence: onGround && fields.length === 0 ? "Observed" : "Supported inference",
      weight: 0,
    });
  }
  if (nearField.length > 0) {
    const fields = [...new Set(nearField.map((x) => (x.where.kind === "near_field" ? x.where.field : "")))].join(", ");
    reasons.push({
      code: "near_field_dip",
      label: `${plural(nearField.length, "dip")} within ${T.airstripNm} NM of ${fields} but higher than a touch-and-go: could be a low pass or go-around, counted lightly`,
      evidence: "Supported inference",
      weight: Math.min(T.nearFieldDipMax, nearField.length * T.nearFieldDipWeight),
    });
  }
  if (anyDips.length > 0) {
    // Report only the drops that were dips: "0 ft" next to a speed-only dip reads like a measurement it is not.
    const altDips = anyDips.filter((d) => d.altitudeDip);
    const spdDips = anyDips.filter((d) => d.speedDip);
    const drops = [
      altDips.length ? `${Math.round(Math.max(...altDips.map((d) => d.altitudeDropFt))).toLocaleString("en-US")} ft` : null,
      spdDips.length ? `${Math.round(Math.max(...spdDips.map((d) => d.speedDropKt)))} kt` : null,
    ].filter(Boolean).join(", ");
    const kind = bothDips.length > 0 ? "altitude and speed" : anyDips.some((d) => d.altitudeDip) ? "altitude" : "speed";
    const weight = bothDips.length >= 2 ? 3 : bothDips.length === 1 ? 2 : 1;
    reasons.push({
      code: "close_dip",
      label: `Dropped ${kind} within 2 mi of your watch center, away from known fields, and recovered after, on ${anyDips.length} of ${plural(dipAssessable, "checkable pass", "checkable passes")} (largest ${drops.includes(",") ? "drops" : "drop"} ${drops})${training ? "; trainers also practice slow flight and descents" : ""}`,
      evidence: "Calculated",
      weight: training ? Math.max(1, weight - 1) : weight,
    });
  } else if (dipAssessable > 0 && dipped.length === 0) {
    // Each metric is reported only for the passes where it was actually checked.
    const altChecked = dips.filter((d) => d.altitudeChecked).length;
    const spdChecked = dips.filter((d) => d.speedChecked).length;
    const parts = [altChecked > 0 ? `no altitude dip on ${plural(altChecked, "checked pass", "checked passes")}` : null, spdChecked > 0 ? `no speed dip on ${plural(spdChecked, "checked pass", "checked passes")}` : null].filter(Boolean);
    reasons.push({ code: "no_close_dip", label: `Within 2 mi of you: ${parts.join("; ")}`, evidence: "Calculated", weight: 0 });
  }
  if (positioned.length > 0 && away.length > 0) {
    const noPositions = dips.filter((d) => !d.assessable).length;
    const altMissing = dips.filter((d) => d.assessable && !d.altitudeChecked).length;
    const spdMissing = dips.filter((d) => d.assessable && !d.speedChecked).length;
    const gaps = [
      noPositions > 0 ? `${plural(noPositions, "pass", "passes")} had no recorded positions on both sides of the 2 mi zone (usually app closed; the always-on net samples too sparsely)` : null,
      altMissing > 0 ? `altitude was not reported on ${plural(altMissing, "pass", "passes")}` : null,
      spdMissing > 0 ? `ground speed was not reported on ${plural(spdMissing, "pass", "passes")}` : null,
    ].filter(Boolean);
    if (gaps.length > 0) reasons.push({ code: "dip_unknown", label: `Dips not fully checked: ${gaps.join("; ")}`, evidence: "Unknown", weight: 0 });
  }

  const hasRegistration = Boolean(input.registration?.trim() || input.registryRegistration?.trim());
  if (!input.callsign?.trim() || !hasRegistration) {
    reasons.push({ code: "identity_gap", label: !input.callsign?.trim() ? "No callsign broadcast" : "No registration on record", evidence: "Observed", weight: 1 });
  }

  const coverage: PatternAssessment["coverage"] = assessable >= 2 ? "ok" : assessable === 1 ? "limited" : "sparse";
  if (coverage === "sparse") reasons.push({ code: "sparse_coverage", label: `Too few recorded positions to judge turning (needs ${T.minPositions}+ over ${T.assessableMinutes}+ min in a visit)`, evidence: "Unknown", weight: 0 });
  if (input.visits.some((visit) => visit.downsampled)) reasons.push({ code: "downsampled", label: "Long visits were evenly downsampled before scoring", evidence: "Unknown", weight: 0 });

  // Does the context (label or airport area) cover what was observed? Signals no label explains:
  const unexplained: string[] = [];
  if (followed) unexplained.push("showed up at your separate locations within hours");
  if (centeredCount >= (training ? 2 : 1)) unexplained.push("orbited your watch center away from any airport");
  if (controlAbsent) unexplained.push("never seen at your control circles");
  if (bothDips.length >= 2) unexplained.push("dropped altitude and speed within 2 mi of you on several visits");
  if ((charter || (mostlyAirport && !training)) && circlingVisits.length > 0) unexplained.push("circled away from any airport");
  const context = label?.label ?? (mostlyAirport ? reasons.find((r) => r.code === "airport_area")!.label : null);
  const fit: PatternAssessment["fit"] = context === null || scheduled ? null : unexplained.length > 0 ? "not_explained" : "consistent";
  if (fit === "not_explained") reasons.push({ code: "context_mismatch", label: `Context does not explain: ${unexplained.join("; ")}`, evidence: "Calculated", weight: 0 });

  let score = reasons.reduce((sum, reason) => sum + reason.weight, 0);
  const behaviorEvidence = reasons.some((r) => r.weight > 0 && r.code !== "identity_gap");
  let tier: PatternTier;
  if (scheduled && !followed) {
    tier = "routine";
    score = Math.min(score, 0);
  } else if (score >= T.priorityScore) tier = coverage === "sparse" && !followed ? "review" : "priority";
  else if (score >= T.reviewScore) tier = "review";
  // A label that does not fit the behavior is exactly what the user should see: never bury it below "review".
  else if (fit === "not_explained" && coverage !== "sparse") tier = "review";
  else if (score <= 0 && reasons.some((r) => r.weight < 0) && fit !== "not_explained") tier = "routine";
  else if (coverage === "sparse" && !behaviorEvidence) tier = "insufficient";
  else tier = "low";
  const explainedBy = tier === "routine" ? (label?.label ?? reasons.find((r) => r.weight < 0)?.label ?? null) : null;
  return { version: PATTERN_ALGORITHM_VERSION, tier, score, explainedBy, context, fit, reasons: reasons.sort((a, b) => b.weight - a.weight), coverage };
}

export const PATTERN_TIER_LABEL: Record<PatternTier, string> = {
  priority: "Priority review",
  review: "Review",
  low: "Low",
  insufficient: "Not enough data",
  routine: "Routine",
};

export const PATTERN_TIER_ORDER: Record<PatternTier, number> = { priority: 0, review: 1, low: 2, insufficient: 3, routine: 4 };
