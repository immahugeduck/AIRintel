import { z } from "zod";
import { distanceNm } from "./geometry.js";

/**
 * Pattern flags (`pattern-flags-v1`): a deterministic review-priority score for netted aircraft.
 *
 * What this is: a ranking of RECORDED behavior inside the watch radius (Calculated) plus identity facts (Observed),
 * so that the few aircraft whose behavior is unusual for this area rise to the top of the list for a human to review.
 *
 * What this is NOT: a finding of intent, mission, sensor use or surveillance. Per AGENTS.md, nothing here claims
 * purpose from geometry. Training aircraft fly "turns around a point" and orbits on purpose; news, survey, medical,
 * police and pipeline-patrol flights all loiter. A high score means "look at this one first", never "this one is
 * watching you". Every reason carries its evidence label so the UI can show why.
 *
 * Passes (all deterministic, no AI guesses):
 *   1. Routine explanations (weed out): scheduled airline/cargo callsigns, fractional/charter jet operators, known
 *      local flight-school fleets, cruise-altitude transit, steady climb/descent through the radius.
 *   2. Behavior inside the radius: long dwell, circling (cumulative heading change), orbits centered near the watch
 *      center, low-and-slow profile.
 *   3. Correlation with YOUR location: the same airframe logged at two or more of your watch centers that are far
 *      apart. This is the only pass that tests "follows me" rather than "flies around here", and it only works when
 *      the watch center actually moves with you.
 *   Plus recurrence across days and identity gaps (missing callsign or registration).
 */
export const PATTERN_ALGORITHM_VERSION = "pattern-flags-v1";

export type PatternPosition = {
  observedAt: string;
  latitude: number;
  longitude: number;
  altitudeFt: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  verticalRateFpm: number | null;
};

export type PatternVisit = {
  enteredAt: string;
  lastSeenInRadiusAt: string;
  /** Watch center this visit was measured against; null when unknown. */
  center: { latitude: number; longitude: number } | null;
  /** Recorded positions during the visit, any order. May be empty (sparse sweeps). */
  positions: PatternPosition[];
};

export type PatternCenter = { latitude: number; longitude: number; encounters: number };

export type PatternInput = {
  icao24: string;
  callsign: string | null;
  registration: string | null;
  aircraftTypeCode: string | null;
  /** Lifetime (log) or window visit count. */
  visitCount: number;
  /** Newest visits with positions (bounded by the caller). */
  visits: PatternVisit[];
  /** Every distinct watch center this aircraft was encountered at (log scope); empty in window scope. */
  centers: PatternCenter[];
};

export const patternEvidenceSchema = z.enum(["Observed", "Calculated", "Supported inference", "Unknown"]);
export const patternReasonSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  evidence: patternEvidenceSchema,
  /** Positive raises review priority; negative is a routine explanation. */
  weight: z.number().finite(),
});
export const patternTierSchema = z.enum(["priority", "review", "low", "routine"]);
export const patternAssessmentSchema = z.object({
  version: z.string().min(1),
  tier: patternTierSchema,
  score: z.number().finite(),
  /** Short routine explanation when tier is "routine" (e.g. "LIFT Academy training fleet"). */
  explainedBy: z.string().nullable(),
  reasons: z.array(patternReasonSchema),
  /** "sparse" when too few positions were recorded to judge turning/dwell reliably. */
  coverage: z.enum(["ok", "sparse"]),
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
  /**
   * Two watch centers count as separate places only when circles of the default 7 mi (6.1 NM) radius cannot overlap,
   * with margin. Closer centers let one straight pass (e.g. an airliner at cruise) register at "both" places.
   */
  separateCentersNm: 20,
  recurrenceVisits: 5,
  recurrenceDays: 3,
  minTrackSamples: 4,
  priorityScore: 7,
  reviewScore: 4,
} as const;

/**
 * Scheduled passenger/cargo airline ICAO designators commonly seen over central Indiana. A callsign of the form
 * <designator><flight number> from these operators is a published scheduled or cargo operation (Observed callsign).
 */
export const SCHEDULED_OPERATORS: Readonly<Record<string, string>> = {
  AAL: "American Airlines", ACA: "Air Canada", AFR: "Air France", AMX: "Aeroméxico", ASA: "Alaska Airlines", ASH: "Mesa Airlines",
  AAY: "Allegiant Air", AWI: "Air Wisconsin", BAW: "British Airways", DAL: "Delta Air Lines", DLH: "Lufthansa", EDV: "Endeavor Air",
  ENY: "Envoy Air", FFT: "Frontier Airlines", GJS: "GoJet Airlines", JBU: "JetBlue", JIA: "PSA Airlines", JZA: "Jazz Aviation",
  MXY: "Breeze Airways", NKS: "Spirit Airlines", PDT: "Piedmont Airlines", QXE: "Horizon Air", RPA: "Republic Airways",
  SCX: "Sun Country", SKW: "SkyWest Airlines", SWA: "Southwest Airlines", UAL: "United Airlines",
  ABX: "ABX Air (cargo)", ATN: "Air Transport International (cargo)", FDX: "FedEx (cargo)", GTI: "Atlas Air (cargo)", UPS: "UPS (cargo)",
};

/** Fractional-ownership and large charter jet operators. */
export const CHARTER_OPERATORS: Readonly<Record<string, string>> = {
  EJA: "NetJets", LXJ: "Flexjet", XSR: "Executive AirShare", JTL: "Jet Linx", FLE: "Flair Jets",
};

/**
 * Local flight-training fleets. Matched by callsign prefix or registration pattern. Extend this list for your area;
 * a match is a Supported inference (registration patterns can collide), not a certainty.
 */
export const TRAINING_FLEETS: readonly { label: string; callsignPrefix?: string; registration?: RegExp }[] = [
  { label: "LIFT Academy training fleet (Indianapolis Intl)", callsignPrefix: "LTA" },
  { label: "Vincennes University flight-training fleet", registration: /^N\d{1,3}VU$/ },
];

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

/** Absolute net turning in one visit (Calculated). Uses consecutive reported tracks; jumps over 150° are ignored as noise. */
export function cumulativeTurnDeg(positions: readonly PatternPosition[]): { turnDeg: number; samples: number } {
  const tracks = positions
    .filter((p) => p.trackDeg !== null && Number.isFinite(p.trackDeg))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
    .map((p) => p.trackDeg!);
  let net = 0;
  let gross = 0;
  for (let i = 1; i < tracks.length; i += 1) {
    const delta = headingDelta(tracks[i - 1]!, tracks[i]!);
    if (Math.abs(delta) > 150) continue;
    net += delta;
    gross += Math.abs(delta);
  }
  // Net turning separates real orbits (consistent direction) from S-turns/weaving, which add gross but cancel out.
  return { turnDeg: Math.min(Math.abs(net), gross), samples: tracks.length };
}

const visitMinutes = (visit: PatternVisit) => (Date.parse(visit.lastSeenInRadiusAt) - Date.parse(visit.enteredAt)) / 60_000;

/** Clusters watch centers that are within `separateCentersNm` of each other. Returns the number of separate places. */
export function countSeparateCenters(centers: readonly PatternCenter[], separationNm: number = PATTERN_THRESHOLDS.separateCentersNm): number {
  const clusters: { latitude: number; longitude: number }[] = [];
  for (const center of centers) {
    if (!clusters.some((c) => distanceNm(c.latitude, c.longitude, center.latitude, center.longitude) < separationNm)) clusters.push(center);
  }
  return clusters.length;
}

export function routineExplanation(input: Pick<PatternInput, "callsign" | "registration">): { code: string; label: string; evidence: PatternReason["evidence"] } | null {
  const callsign = input.callsign?.trim().toUpperCase() ?? "";
  const registration = input.registration?.trim().toUpperCase() ?? "";
  for (const fleet of TRAINING_FLEETS) {
    if ((fleet.callsignPrefix && callsign.startsWith(fleet.callsignPrefix)) || (fleet.registration && fleet.registration.test(registration))) {
      return { code: "training_fleet", label: fleet.label, evidence: "Supported inference" };
    }
  }
  const match = OPERATOR_CALLSIGN.exec(callsign);
  if (match) {
    const designator = match[1]!;
    if (SCHEDULED_OPERATORS[designator]) return { code: "scheduled_operator", label: `${SCHEDULED_OPERATORS[designator]} flight number`, evidence: "Observed" };
    if (CHARTER_OPERATORS[designator]) return { code: "charter_operator", label: `${CHARTER_OPERATORS[designator]} (fractional/charter jet)`, evidence: "Observed" };
  }
  return null;
}

/** Pure, deterministic assessment of one netted aircraft. */
export function assessPattern(input: PatternInput): PatternAssessment {
  const T = PATTERN_THRESHOLDS;
  const reasons: PatternReason[] = [];
  const positions = input.visits.flatMap((visit) => visit.positions);
  const altitudes = positions.flatMap((p) => (p.altitudeFt === null ? [] : [p.altitudeFt]));
  const speeds = positions.flatMap((p) => (p.groundSpeedKt === null ? [] : [p.groundSpeedKt]));
  const verticals = positions.flatMap((p) => (p.verticalRateFpm === null ? [] : [p.verticalRateFpm]));
  const medianAltitudeFt = median(altitudes);
  const medianSpeedKt = median(speeds);

  // Pass 1: routine explanations.
  const routine = routineExplanation(input);
  if (routine) reasons.push({ code: routine.code, label: routine.label, evidence: routine.evidence, weight: -4 });
  if (medianAltitudeFt !== null && medianAltitudeFt >= T.cruiseAltitudeFt) {
    reasons.push({ code: "cruise_transit", label: `Passing through at cruise altitude (median ${Math.round(medianAltitudeFt).toLocaleString("en-US")} ft)`, evidence: "Calculated", weight: -3 });
  }
  if (verticals.length >= 3 && verticals.filter((v) => Math.abs(v) >= T.climbDescentFpm).length / verticals.length >= 0.6) {
    reasons.push({ code: "climb_descent", label: "Climbing or descending steadily through the radius (arrival/departure profile)", evidence: "Calculated", weight: -2 });
  }

  // Pass 2: behavior inside the radius.
  let trackSamples = 0;
  let circlingVisits = 0;
  let centeredOrbits = 0;
  let maxTurn = 0;
  for (const visit of input.visits) {
    const { turnDeg, samples } = cumulativeTurnDeg(visit.positions);
    trackSamples += samples;
    if (samples < T.minTrackSamples || turnDeg < T.circlingTurnDeg) continue;
    circlingVisits += 1;
    maxTurn = Math.max(maxTurn, turnDeg);
    if (visit.center && visit.positions.length > 0) {
      const lat = visit.positions.reduce((sum, p) => sum + p.latitude, 0) / visit.positions.length;
      const lon = visit.positions.reduce((sum, p) => sum + p.longitude, 0) / visit.positions.length;
      if (distanceNm(visit.center.latitude, visit.center.longitude, lat, lon) <= T.orbitCenterNm) centeredOrbits += 1;
    }
  }
  if (circlingVisits > 0) {
    reasons.push({ code: "circling", label: `Circled inside the radius on ${circlingVisits} ${circlingVisits === 1 ? "visit" : "visits"} (up to ${Math.round(maxTurn)}° of turn)`, evidence: "Calculated", weight: 3 });
  }
  if (centeredOrbits > 0) {
    reasons.push({ code: "centered_orbit", label: `Orbit centered within ${T.orbitCenterNm} NM of the watch center on ${centeredOrbits} ${centeredOrbits === 1 ? "visit" : "visits"}`, evidence: "Calculated", weight: 2 });
  }
  const longVisits = input.visits.filter((visit) => visitMinutes(visit) >= T.loiterMinutes);
  if (longVisits.length > 0) {
    const longest = Math.round(Math.max(...longVisits.map(visitMinutes)));
    reasons.push({ code: "loiter", label: `Stayed inside the radius ${T.loiterMinutes}+ min on ${longVisits.length} ${longVisits.length === 1 ? "visit" : "visits"} (longest ${longest} min)`, evidence: "Calculated", weight: longVisits.length >= 3 ? 3 : 2 });
  }
  if (medianAltitudeFt !== null && medianSpeedKt !== null && medianAltitudeFt <= T.lowAltitudeFt && medianSpeedKt <= T.slowGroundSpeedKt) {
    reasons.push({ code: "low_slow", label: `Low and slow (median ${Math.round(medianAltitudeFt).toLocaleString("en-US")} ft, ${Math.round(medianSpeedKt)} kt)`, evidence: "Calculated", weight: 1 });
  }

  // Pass 3: correlation with the user's own watch centers.
  const places = countSeparateCenters(input.centers);
  const transit = reasons.some((r) => r.code === "cruise_transit");
  if (places >= 2 && !transit) {
    reasons.push({ code: "multi_location", label: `Logged at ${places} of your watch locations at least ${T.separateCentersNm} NM apart`, evidence: "Calculated", weight: places >= 3 ? 5 : 4 });
  }

  // Recurrence and identity.
  const days = new Set(input.visits.map((visit) => visit.enteredAt.slice(0, 10))).size;
  if (input.visitCount >= T.recurrenceVisits && days >= T.recurrenceDays) {
    reasons.push({ code: "recurrence", label: `${input.visitCount} entries across ${days}+ days`, evidence: "Observed", weight: routine ? 0 : 2 });
  }
  if (!input.callsign?.trim() || !input.registration?.trim()) {
    reasons.push({ code: "identity_gap", label: !input.callsign?.trim() ? "No callsign broadcast" : "No registration on record", evidence: "Observed", weight: 1 });
  }

  const coverage: PatternAssessment["coverage"] = trackSamples < T.minTrackSamples ? "sparse" : "ok";
  if (coverage === "sparse") reasons.push({ code: "sparse_coverage", label: "Too few recorded positions to judge turning", evidence: "Unknown", weight: 0 });

  let score = reasons.reduce((sum, reason) => sum + reason.weight, 0);
  // A routine operator only escalates on the location-correlation pass; its circling/loitering is expected
  // (training maneuvers, holding, approaches).
  let tier: PatternTier;
  if (routine && (places < 2 || transit)) {
    tier = "routine";
    score = Math.min(score, 0);
  } else if (score >= T.priorityScore) tier = "priority";
  else if (score >= T.reviewScore) tier = "review";
  else if (!routine && reasons.some((r) => r.code === "cruise_transit" || r.code === "climb_descent") && score <= 0) tier = "routine";
  else tier = "low";
  const explainedBy = tier === "routine" ? (routine?.label ?? reasons.find((r) => r.weight < 0)?.label ?? null) : null;
  return { version: PATTERN_ALGORITHM_VERSION, tier, score, explainedBy, reasons: reasons.sort((a, b) => b.weight - a.weight), coverage };
}

export const PATTERN_TIER_LABEL: Record<PatternTier, string> = {
  priority: "Priority review",
  review: "Review",
  low: "Low",
  routine: "Routine",
};

export const PATTERN_TIER_ORDER: Record<PatternTier, number> = { priority: 0, review: 1, low: 2, routine: 3 };
