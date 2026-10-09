import { z } from "zod";
import { distanceNm } from "./geometry.js";
import { MAX_WATCH_RADIUS_MI, MIN_WATCH_RADIUS_MI, VISIT_GAP_MINUTES, WATCH_RADIUS_MI, milesToNm, nmToMiles } from "./units.js";

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
};

export type NettedAircraftSummary = {
  icao24: string;
  callsign: string | null;
  registration: string | null;
  visitCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  closestApproachNm: number;
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
          summary = { icao24, callsign: null, registration: null, visitCount: 0, firstSeenAt: new Date(time).toISOString(), lastSeenAt: new Date(time).toISOString(), closestApproachNm: distance };
        }
        if (startsVisit) summary.visitCount += 1;
        summary.lastSeenAt = new Date(time).toISOString();
        summary.closestApproachNm = Math.min(summary.closestApproachNm, distance);
        // Latest non-empty identity values observed inside the radius.
        if (observation.callsign?.trim()) summary.callsign = observation.callsign.trim();
        if (observation.registration?.trim()) summary.registration = observation.registration.trim();
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
});
export type NettedQuery = z.infer<typeof nettedQuerySchema>;

const utc = z.iso.datetime({ offset: true });
export const nettedAircraftSchema = z.object({
  icao24: z.string().regex(/^[0-9a-f]{6}$/),
  callsign: z.string().trim().min(1).nullable(),
  registration: z.string().trim().min(1).nullable(),
  /** Provider-reported ICAO type designator from the latest retained raw observation, when present. */
  aircraftTypeCode: z.string().trim().min(1).nullable(),
  visitCount: z.number().int().positive(),
  firstSeenAt: utc,
  lastSeenAt: utc,
  closestApproachMi: z.number().finite().nonnegative(),
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
});

export const radiusMiToNm = milesToNm;
