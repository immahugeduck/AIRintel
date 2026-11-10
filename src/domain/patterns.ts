import { z } from "zod";
import { distanceNm } from "./geometry.js";
import { CHARTER_OPERATORS, EDUCATION_OWNER, KNOWN_AIRPORTS, PATTERN_TIME_ZONE, SCHEDULED_OPERATORS, TRAINING_FLEETS } from "./pattern-config.js";

export { CHARTER_OPERATORS, KNOWN_AIRPORTS, SCHEDULED_OPERATORS, TRAINING_FLEETS } from "./pattern-config.js";

/**
 * Pattern flags (`pattern-flags-v3`): a deterministic review-priority score for netted aircraft.
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
export const PATTERN_ALGORITHM_VERSION = "pattern-flags-v3";

export type PatternPosition = {
  observedAt: string;
  latitude: number;
  longitude: number;
  altitudeFt: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  verticalRateFpm: number | null;
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

/** Pure, deterministic assessment of one netted aircraft. */
export function assessPattern(input: PatternInput): PatternAssessment {
  const T = PATTERN_THRESHOLDS;
  const timeZone = input.timeZone ?? PATTERN_TIME_ZONE;
  const identity = input.identity ?? {};
  const reasons: PatternReason[] = [];
  const positions = input.visits.flatMap((visit) => visit.positions);
  const altitudes = positions.flatMap((p) => (p.altitudeFt === null ? [] : [p.altitudeFt]));
  const speeds = positions.flatMap((p) => (p.groundSpeedKt === null ? [] : [p.groundSpeedKt]));
  const verticals = positions.flatMap((p) => (p.verticalRateFpm === null ? [] : [p.verticalRateFpm]));
  const medianAltitudeFt = median(altitudes);
  const medianSpeedKt = median(speeds);

  // Pass 2 geometry first: the airport-pattern explanation depends on it.
  const evidence = input.visits.map((visit) => ({ visit, geometry: circlingEvidence(visit.positions) }));
  const assessable = evidence.filter((e) => e.geometry.assessable).length;
  const circlingVisits = evidence.filter((e) => e.geometry.circling);
  const patternAirports = circlingVisits.map((e) => airportPatternAt(e.geometry.centroid!, e.geometry.medianAltitudeFt));
  const airportExplained = circlingVisits.length > 0 && patternAirports.every((id) => id !== null);

  // Pass 1: routine explanations.
  let routine: RoutineMatch | null = routineExplanation({ callsign: input.callsign, registration: input.registration, registryRegistration: input.registryRegistration, registrantName: identity.registrantName });
  if (routine) reasons.push({ ...routine, weight: -4 });
  if (!routine && airportExplained) {
    const ids = [...new Set(patternAirports as string[])].join(", ");
    routine = { code: "airport_pattern", label: `Circling within ${T.airportPatternNm} NM of ${ids} at pattern altitude (traffic pattern or practice approaches)`, evidence: "Supported inference" };
    reasons.push({ ...routine, weight: -3 });
  }
  if (medianAltitudeFt !== null && medianAltitudeFt >= T.cruiseAltitudeFt) {
    reasons.push({ code: "cruise_transit", label: `Passing through at cruise altitude (median ${Math.round(medianAltitudeFt).toLocaleString("en-US")} ft)`, evidence: "Calculated", weight: -3 });
  }
  if (verticals.length >= 3 && verticals.filter((v) => Math.abs(v) >= T.climbDescentFpm).length / verticals.length >= 0.6) {
    reasons.push({ code: "climb_descent", label: "Climbing or descending steadily through the radius (arrival/departure profile)", evidence: "Calculated", weight: -2 });
  }
  const transit = reasons.some((r) => r.code === "cruise_transit");

  // Pass 2: behavior inside the radius.
  if (circlingVisits.length > 0) {
    const maxTurn = Math.max(...circlingVisits.map((e) => e.geometry.turnDeg));
    const estimated = circlingVisits.every((e) => e.geometry.method === "confined");
    reasons.push({ code: "circling", label: `Circled inside the radius on ${plural(circlingVisits.length, "visit")} (${estimated ? "about " : "up to "}${Math.round(maxTurn).toLocaleString("en-US")}° of turn${estimated ? ", estimated from distance flown in a small area" : ""})`, evidence: "Calculated", weight: 3 });
    const centered = circlingVisits.filter((e) => e.visit.center && distanceNm(e.visit.center.latitude, e.visit.center.longitude, e.geometry.centroid!.latitude, e.geometry.centroid!.longitude) <= T.orbitCenterNm).length;
    if (centered > 0) reasons.push({ code: "centered_orbit", label: `Orbit centered within ${T.orbitCenterNm} NM of the watch center on ${plural(centered, "visit")}`, evidence: "Calculated", weight: 2 });
  }
  const longVisits = input.visits.filter((visit) => visitMinutes(visit) >= T.loiterMinutes);
  if (longVisits.length > 0) {
    const longest = Math.round(Math.max(...longVisits.map(visitMinutes)));
    reasons.push({ code: "loiter", label: `Stayed inside the radius ${T.loiterMinutes}+ min on ${plural(longVisits.length, "visit")} (longest ${longest} min)`, evidence: "Calculated", weight: longVisits.length >= 3 ? 3 : 2 });
  }
  if (positions.length >= T.minPositions && medianAltitudeFt !== null && medianSpeedKt !== null && medianAltitudeFt <= T.lowAltitudeFt && medianSpeedKt <= T.slowGroundSpeedKt) {
    reasons.push({ code: "low_slow", label: `Low and slow (median ${Math.round(medianAltitudeFt).toLocaleString("en-US")} ft, ${Math.round(medianSpeedKt)} kt)`, evidence: "Calculated", weight: 1 });
  }

  // Pass 3: time-aware correlation with the user's own watch centers.
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

  // Recurrence across local days.
  const days = new Set(input.visits.map((visit) => localDay(visit.enteredAt, timeZone))).size;

  // Pass 4: comparison with the user's control circles.
  if (input.control && input.control.activeCircles > 0) {
    const atControls = input.control.daysAtControls;
    const circles = input.control.activeCircles === 1 ? "your control circle" : "your control circles";
    if (atControls >= T.controlCommonDays && atControls * 2 >= days) {
      reasons.push({ code: "control_common", label: `Also seen at ${circles} on ${atControls} days: common local traffic, not specific to you`, evidence: "Calculated", weight: -2 });
    } else if (atControls === 0 && days >= T.controlAbsentYourDays) {
      reasons.push({ code: "control_absent", label: `Seen near you on ${days} days but never at ${circles}`, evidence: "Calculated", weight: 1 });
    }
  }
  if (input.visitCount >= T.recurrenceVisits && days >= T.recurrenceDays) {
    reasons.push({ code: "recurrence", label: `${input.visitCount} entries, on ${days}+ local days`, evidence: "Observed", weight: routine ? 0 : 2 });
  }
  const hasRegistration = Boolean(input.registration?.trim() || input.registryRegistration?.trim());
  if (!input.callsign?.trim() || !hasRegistration) {
    reasons.push({ code: "identity_gap", label: !input.callsign?.trim() ? "No callsign broadcast" : "No registration on record", evidence: "Observed", weight: 1 });
  }

  const coverage: PatternAssessment["coverage"] = assessable >= 2 ? "ok" : assessable === 1 ? "limited" : "sparse";
  if (coverage === "sparse") reasons.push({ code: "sparse_coverage", label: `Too few recorded positions to judge turning (needs ${T.minPositions}+ over ${T.assessableMinutes}+ min in a visit)`, evidence: "Unknown", weight: 0 });
  if (input.visits.some((visit) => visit.downsampled)) reasons.push({ code: "downsampled", label: "Long visits were evenly downsampled before scoring", evidence: "Unknown", weight: 0 });

  let score = reasons.reduce((sum, reason) => sum + reason.weight, 0);
  const behaviorEvidence = reasons.some((r) => r.weight > 0 && r.code !== "identity_gap");
  let tier: PatternTier;
  if (routine) {
    // A routine operator, fleet or airport pattern stays routine: its circling, loitering and presence at several of
    // your places are expected (training areas, holds, approaches, airline routes).
    tier = "routine";
    score = Math.min(score, 0);
  } else if (score >= T.priorityScore) tier = coverage === "sparse" && !followed ? "review" : "priority";
  else if (score >= T.reviewScore) tier = "review";
  else if (reasons.some((r) => r.code === "cruise_transit" || r.code === "climb_descent") && score <= 0) tier = "routine";
  else if (coverage === "sparse" && !behaviorEvidence) tier = "insufficient";
  else tier = "low";
  const explainedBy = tier === "routine" ? (routine?.label ?? reasons.find((r) => r.weight < 0)?.label ?? null) : null;
  return { version: PATTERN_ALGORITHM_VERSION, tier, score, explainedBy, reasons: reasons.sort((a, b) => b.weight - a.weight), coverage };
}

export const PATTERN_TIER_LABEL: Record<PatternTier, string> = {
  priority: "Priority review",
  review: "Review",
  low: "Low",
  insufficient: "Not enough data",
  routine: "Routine",
};

export const PATTERN_TIER_ORDER: Record<PatternTier, number> = { priority: 0, review: 1, low: 2, insufficient: 3, routine: 4 };
