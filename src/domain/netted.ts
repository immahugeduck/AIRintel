import { z } from "zod";
import { bearingDeg, distanceNm } from "./geometry.js";
import { netStatusSchema } from "./net.js";
import { patternAssessmentSchema } from "./patterns.js";
import { MAX_WATCH_RADIUS_MI, MIN_WATCH_RADIUS_MI, VISIT_GAP_MINUTES, WATCH_RADIUS_MI, nmToMiles } from "./units.js";

/**
 * "Netted aircraft": aircraft that were OBSERVED inside the watch radius, with a deterministic visit counter.
 *
 * Visit definition (algorithm `netted-visits-v1`), evaluated per ICAO24 over observations in time order:
 *   an observation inside the radius (distance <= radius, inclusive) starts a NEW visit when
 *     (a) it is the first observation of that aircraft in the window, or
 *     (b) the previous observation of that aircraft was outside the radius, or
 *     (c) more than `gapMinutes` (default 10) elapsed since the previous observation of that aircraft (reception gap).
 *   Consecutive inside observations within the gap continue the same visit.
 * Only real recorded observations are counted; nothing is interpolated across gaps.
 */
export const NETTED_ALGORITHM_VERSION = "netted-visits-v1";
export const NETTED_DEFAULT_HOURS = 24;
export const NETTED_MAX_HOURS = 168;

export type VisitObservation = {
  icao24: string;
  observedAt: string;
  latitude: number;
  longitude: number;
  callsign?: string | null | undefined;
  registration?: string | null | undefined;
  /** Provider-reported flight state (Observed); absent/null = Unknown. Used for the closest-point snapshot. */
  altitudeFt?: number | null | undefined;
  altitudeSource?: "geometric" | "barometric" | "provider" | null | undefined;
  groundSpeedKt?: number | null | undefined;
  trackDeg?: number | null | undefined;
  verticalRateFpm?: number | null | undefined;
  onGround?: boolean | null | undefined;
};

/**
 * Flight state at the recorded observation nearest the watch center during one visit (Observed values; the bearing
 * and distance are Calculated). With sparse sampling the real closest moment can fall between two samples; nothing is
 * interpolated, so this is the closest RECORDED position.
 */
export const closestPointSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  altitudeFt: z.number().finite().nullable(),
  altitudeSource: z.enum(["geometric", "barometric", "provider"]).nullable(),
  groundSpeedKt: z.number().finite().nonnegative().nullable(),
  trackDeg: z.number().finite().min(0).lt(360).nullable(),
  verticalRateFpm: z.number().finite().nullable(),
  onGround: z.boolean().nullable(),
  /** Direction from the watch center to the aircraft at that moment, degrees true. */
  bearingFromCenterDeg: z.number().finite().min(0).lt(360).nullable(),
  /** "at_write": captured when the encounter was logged; "backfill": derived later from retained positions; "window": recomputed for this view. */
  basis: z.enum(["at_write", "backfill", "window"]),
});
export type ClosestPoint = z.infer<typeof closestPointSchema>;

const finiteOrNull = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Snapshot of one observation as a closest point measured from `center`. */
export function closestPointFrom(observation: VisitObservation, center: { latitude: number; longitude: number }, basis: ClosestPoint["basis"]): ClosestPoint {
  const altitudeFt = finiteOrNull(observation.altitudeFt);
  const track = finiteOrNull(observation.trackDeg);
  const speed = finiteOrNull(observation.groundSpeedKt);
  const sameSpot = observation.latitude === center.latitude && observation.longitude === center.longitude;
  return {
    at: new Date(Date.parse(observation.observedAt)).toISOString(),
    latitude: observation.latitude,
    longitude: observation.longitude,
    altitudeFt,
    altitudeSource: altitudeFt === null ? null : observation.altitudeSource ?? null,
    groundSpeedKt: speed !== null && speed >= 0 ? speed : null,
    trackDeg: track !== null && track >= 0 && track < 360 ? track : null,
    verticalRateFpm: finiteOrNull(observation.verticalRateFpm),
    onGround: typeof observation.onGround === "boolean" ? observation.onGround : null,
    bearingFromCenterDeg: sameSpot ? null : bearingDeg(center.latitude, center.longitude, observation.latitude, observation.longitude),
    basis,
  };
}

/** One visit (entry) into the radius: first observation inside, last observation inside before it ended, closest approach. */
export type RadiusVisit = {
  enteredAt: string;
  lastSeenInRadiusAt: string;
  closestApproachNm: number;
  /** Observations recorded inside the radius during this visit (Observed). */
  observationCount: number;
  /** Flight state at the closest recorded observation of this visit. */
  closest?: ClosestPoint | undefined;
  /** Last observation outside the radius before entry / first after leaving, within the gap (Observed); null = Unknown. */
  enteredAfter?: string | null | undefined;
  exitedBefore?: string | null | undefined;
};

export type NettedAircraftSummary = {
  icao24: string;
  callsign: string | null;
  registration: string | null;
  visitCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  closestApproachNm: number;
  /** Every visit in chronological order (oldest first). visitCount === visits.length. */
  visits: RadiusVisit[];
};

export type VisitOptions = { latitude: number; longitude: number; radiusNm: number; gapMinutes?: number };

export function countRadiusVisits(observations: readonly VisitObservation[], options: VisitOptions): NettedAircraftSummary[] {
  const gapMs = (options.gapMinutes ?? VISIT_GAP_MINUTES) * 60_000;
  const byAircraft = new Map<string, VisitObservation[]>();
  for (const observation of observations) {
    const time = Date.parse(observation.observedAt);
    if (!Number.isFinite(time)) continue;
    const key = observation.icao24.toLowerCase();
    const list = byAircraft.get(key);
    if (list) list.push(observation); else byAircraft.set(key, [observation]);
  }

  const results: NettedAircraftSummary[] = [];
  for (const [icao24, list] of byAircraft) {
    list.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    let previous: { time: number; inside: boolean } | null = null;
    let summary: NettedAircraftSummary | null = null;
    for (const observation of list) {
      const time = Date.parse(observation.observedAt);
      const distance = distanceNm(options.latitude, options.longitude, observation.latitude, observation.longitude);
      const inside = distance <= options.radiusNm;
      if (inside) {
        const startsVisit = previous === null || !previous.inside || time - previous.time > gapMs;
        if (!summary) {
          summary = { icao24, callsign: null, registration: null, visitCount: 0, firstSeenAt: new Date(time).toISOString(), lastSeenAt: new Date(time).toISOString(), closestApproachNm: distance, visits: [] };
        }
        const stamp = new Date(time).toISOString();
        if (startsVisit) {
          summary.visitCount += 1;
          const enteredAfter = previous !== null && !previous.inside && time - previous.time <= gapMs ? new Date(previous.time).toISOString() : null;
          summary.visits.push({ enteredAt: stamp, lastSeenInRadiusAt: stamp, closestApproachNm: distance, observationCount: 0, closest: closestPointFrom(observation, options, "window"), enteredAfter, exitedBefore: null });
        }
        const visit = summary.visits[summary.visits.length - 1]!;
        visit.lastSeenInRadiusAt = stamp;
        if (distance < visit.closestApproachNm) { visit.closestApproachNm = distance; visit.closest = closestPointFrom(observation, options, "window"); }
        visit.observationCount += 1;
        summary.lastSeenAt = stamp;
        summary.closestApproachNm = Math.min(summary.closestApproachNm, distance);
        // Latest non-empty identity values observed inside the radius.
        if (observation.callsign?.trim()) summary.callsign = observation.callsign.trim();
        if (observation.registration?.trim()) summary.registration = observation.registration.trim();
      } else if (summary && previous?.inside && time - previous.time <= gapMs) {
        // Leaving: this outside observation bounds the exit of the visit that just ended.
        summary.visits[summary.visits.length - 1]!.exitedBefore = new Date(time).toISOString();
      }
      previous = { time, inside };
    }
    if (summary) results.push(summary);
  }
  return results.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}

/** Query contract for GET /history?action=netted (shared by the server route and the browser client). */
export const nettedQuerySchema = z.object({
  lat: z.coerce.number().finite().min(-90).max(90),
  lon: z.coerce.number().finite().min(-180).max(180),
  radiusMi: z.coerce.number().finite().min(MIN_WATCH_RADIUS_MI).max(MAX_WATCH_RADIUS_MI).default(WATCH_RADIUS_MI),
  hours: z.coerce.number().int().min(1).max(NETTED_MAX_HOURS).default(NETTED_DEFAULT_HOURS),
  /**
   * "log": the caller's saved per-account encounter log with lifetime counts (migration 0006). The server falls back
   * to "window" (visits recomputed from recorded positions in the last `hours`) while that log is empty or missing.
   */
  scope: z.enum(["window", "log"]).default("window"),
});
export type NettedQuery = z.infer<typeof nettedQuerySchema>;

const utc = z.iso.datetime({ offset: true });
/** Newest visits returned per aircraft; `visitCount` always reports the total. */
export const MAX_VISITS_PER_AIRCRAFT = 100;
export const radiusVisitSchema = z.object({
  enteredAt: utc,
  lastSeenInRadiusAt: utc,
  closestMi: z.number().finite().nonnegative(),
  observationCount: z.number().int().positive(),
  /** Watch center this entry was measured against (log scope). Older servers omit it. */
  centerLatitude: z.number().finite().min(-90).max(90).nullish(),
  centerLongitude: z.number().finite().min(-180).max(180).nullish(),
  /** Flight state at the closest recorded point. Null when unknown (older entries whose positions were purged); older servers omit it. */
  closest: closestPointSchema.nullish(),
  /**
   * Timing bounds (Observed): the last sighting outside the radius before this entry and the first sighting outside
   * after it, when within the reception gap. Real time inside lies between lastSeenInRadiusAt − enteredAt and
   * exitedBefore − enteredAfter. Null = Unknown; older servers omit them.
   */
  enteredAfter: utc.nullish(),
  exitedBefore: utc.nullish(),
  /** Radius this entry was measured against (statute miles). Older servers omit it. */
  radiusMi: z.number().finite().positive().nullish(),
});
export type NettedVisit = z.infer<typeof radiusVisitSchema>;

export const nettedAircraftSchema = z.object({
  icao24: z.string().regex(/^[0-9a-f]{6}$/),
  callsign: z.string().trim().min(1).nullable(),
  registration: z.string().trim().min(1).nullable(),
  /**
   * N-number from the published FAA registry snapshot (exact Mode-S match) when the aircraft broadcast no registration.
   * Older servers omit it.
   */
  registryRegistration: z.string().trim().min(1).nullish(),
  /** "MANUFACTURER MODEL" from the FAA registry when the provider reported no type designator. Older servers omit it. */
  registryModel: z.string().trim().min(1).nullish(),
  /** Provider-reported ICAO type designator from the latest retained raw observation, when present. */
  aircraftTypeCode: z.string().trim().min(1).nullable(),
  /** Encounters counted: lifetime total for the account when the response source is "log", else within the window. */
  visitCount: z.number().int().positive(),
  firstSeenAt: utc,
  lastSeenAt: utc,
  closestApproachMi: z.number().finite().nonnegative(),
  /** Individual entries, newest first (at most MAX_VISITS_PER_AIRCRAFT). Older servers omit this; treated as empty. */
  visits: z.array(radiusVisitSchema).default([]),
  /** Review-priority flags (`pattern-flags-v6`, src/domain/patterns.ts). Calculated behavior only, never intent. */
  pattern: patternAssessmentSchema.nullish(),
});
export type NettedAircraft = z.infer<typeof nettedAircraftSchema>;

export const nettedResponseSchema = z.object({
  query: z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    radiusMi: z.number().finite().positive(),
    radiusNm: z.number().finite().positive(),
    hours: z.number().int().positive(),
    visitGapMinutes: z.number().positive(),
  }),
  windowStart: utc,
  windowEnd: utc,
  receivedAt: utc,
  algorithmVersion: z.string().min(1),
  truncated: z.boolean(),
  aircraft: z.array(nettedAircraftSchema),
  /** Freshness of the always-on net for the caller; absent from older servers. */
  net: netStatusSchema.nullish(),
  /** "log": lifetime counts from the saved per-account log; "window": recomputed for the time window. Older servers omit it. */
  source: z.enum(["window", "log"]).default("window"),
  /** Whether pattern flags are complete ("partial" / "failed" explain what is missing). Older servers omit it. */
  patternStatus: z.object({ state: z.enum(["ok", "partial", "failed"]), detail: z.string().nullable() }).nullish(),
});
export type NettedResponse = z.infer<typeof nettedResponseSchema>;

export const toNettedDto = (summary: NettedAircraftSummary, aircraftTypeCode: string | null = null): NettedAircraft => ({
  icao24: summary.icao24,
  callsign: summary.callsign,
  registration: summary.registration,
  aircraftTypeCode,
  visitCount: summary.visitCount,
  firstSeenAt: summary.firstSeenAt,
  lastSeenAt: summary.lastSeenAt,
  closestApproachMi: nmToMiles(summary.closestApproachNm),
  // Newest first, bounded; visitCount stays the full total.
  visits: summary.visits.slice(-MAX_VISITS_PER_AIRCRAFT).reverse().map((visit) => ({
    enteredAt: visit.enteredAt,
    lastSeenInRadiusAt: visit.lastSeenInRadiusAt,
    closestMi: nmToMiles(visit.closestApproachNm),
    observationCount: visit.observationCount,
    closest: visit.closest ?? null,
    enteredAfter: visit.enteredAfter ?? null,
    exitedBefore: visit.exitedBefore ?? null,
  })),
});

