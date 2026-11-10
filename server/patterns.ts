import { distanceNm } from "../src/domain/geometry.js";
import type { NettedAircraft } from "../src/domain/netted.js";
import { assessPattern, type PatternAssessment, type PatternCenter, type PatternPosition, type PatternVisit } from "../src/domain/patterns.js";
import { iso, type Queryable } from "./db.js";
import { loadControlComparison } from "./control-areas.js";
import { errorFields, log } from "./logger.js";

/** Newest encounters per aircraft whose positions are loaded for pattern scoring. */
export const PATTERN_VISITS_PER_AIRCRAFT = 20;
const POSITION_ROW_LIMIT = 50_000;

type PositionRow = {
  encounter_id: string; icao24: string; entered_at: Date; last_seen_in_radius_at: Date; center_latitude: number; center_longitude: number;
  observed_at: Date | null; latitude: number | null; longitude: number | null; altitude_ft: number | null; ground_speed_kt: number | null;
  track_deg: number | null; vertical_rate_fpm: number | null;
};

const toPosition = (row: { observed_at: Date; latitude: number; longitude: number; altitude_ft: number | null; ground_speed_kt: number | null; track_deg: number | null; vertical_rate_fpm: number | null }): PatternPosition => ({
  observedAt: iso(row.observed_at)!,
  latitude: row.latitude,
  longitude: row.longitude,
  altitudeFt: row.altitude_ft,
  groundSpeedKt: row.ground_speed_kt,
  trackDeg: row.track_deg,
  verticalRateFpm: row.vertical_rate_fpm,
});

/**
 * Log scope: scores the caller's saved aircraft from their own encounters (newest PATTERN_VISITS_PER_AIRCRAFT each,
 * with the recorded positions between entry and last-seen) and every distinct watch center they were logged at.
 * Never throws: on any failure the list is returned without pattern flags.
 */
export async function assessLogPatterns(db: Queryable, userId: string, aircraft: readonly NettedAircraft[]): Promise<Map<string, PatternAssessment>> {
  const result = new Map<string, PatternAssessment>();
  if (aircraft.length === 0) return result;
  const icaos = aircraft.map((item) => item.icao24);
  try {
    const [positions, centers, controls] = await Promise.all([
      db.query<PositionRow>(
        `with ranked as (
           select e.id, e.icao24, e.entered_at, e.last_seen_in_radius_at, e.center_latitude, e.center_longitude,
                  row_number() over (partition by e.icao24 order by e.entered_at desc) as rn
             from airintel_private.encounters e
            where e.user_id = $1::uuid and e.icao24 = any($2::text[])
         )
         select r.id as encounter_id, r.icao24, r.entered_at, r.last_seen_in_radius_at, r.center_latitude, r.center_longitude,
                p.observed_at, p.latitude, p.longitude, p.altitude_ft, p.ground_speed_kt, p.track_deg, p.vertical_rate_fpm
           from ranked r
           left join public.aircraft a on a.icao24 = r.icao24
           left join public.aircraft_positions p on p.aircraft_id = a.id and p.observed_at >= r.entered_at and p.observed_at <= r.last_seen_in_radius_at
          where r.rn <= $3
          order by r.icao24, r.entered_at, p.observed_at
          limit ${POSITION_ROW_LIMIT}`,
        [userId, icaos, PATTERN_VISITS_PER_AIRCRAFT],
      ),
      db.query<{ icao24: string; latitude: number; longitude: number; encounters: number }>(
        `select icao24, round(center_latitude::numeric, 3)::float8 as latitude, round(center_longitude::numeric, 3)::float8 as longitude, count(*)::int as encounters
           from airintel_private.encounters
          where user_id = $1::uuid and icao24 = any($2::text[])
          group by 1, 2, 3`,
        [userId, icaos],
      ),
      // Never fatal: a control-comparison failure just leaves pass 4 out.
      loadControlComparison(db, userId, icaos).catch((error: unknown) => { log("warn", "pattern_control_comparison_failed", errorFields(error)); return new Map(); }),
    ]);
    const visitsByAircraft = new Map<string, Map<string, PatternVisit>>();
    for (const row of positions.rows) {
      const visits = visitsByAircraft.get(row.icao24) ?? new Map<string, PatternVisit>();
      visitsByAircraft.set(row.icao24, visits);
      let visit = visits.get(row.encounter_id);
      if (!visit) {
        visit = { enteredAt: iso(row.entered_at)!, lastSeenInRadiusAt: iso(row.last_seen_in_radius_at)!, center: { latitude: row.center_latitude, longitude: row.center_longitude }, positions: [] };
        visits.set(row.encounter_id, visit);
      }
      if (row.observed_at && row.latitude !== null && row.longitude !== null) {
        visit.positions.push(toPosition({ ...row, observed_at: row.observed_at, latitude: row.latitude, longitude: row.longitude }));
      }
    }
    const centersByAircraft = new Map<string, PatternCenter[]>();
    for (const row of centers.rows) {
      const list = centersByAircraft.get(row.icao24) ?? [];
      list.push({ latitude: row.latitude, longitude: row.longitude, encounters: row.encounters });
      centersByAircraft.set(row.icao24, list);
    }
    for (const item of aircraft) {
      result.set(item.icao24, assessPattern({
        icao24: item.icao24,
        callsign: item.callsign,
        // A registry N-number (FAA, exact Mode S) closes the identity gap just like a broadcast registration.
        registration: item.registration ?? item.registryRegistration ?? null,
        aircraftTypeCode: item.aircraftTypeCode,
        visitCount: item.visitCount,
        visits: [...(visitsByAircraft.get(item.icao24)?.values() ?? [])],
        centers: centersByAircraft.get(item.icao24) ?? [],
        control: controls.get(item.icao24),
      }));
    }
  } catch (error) {
    log("error", "pattern_assessment_failed", { scope: "log", ...errorFields(error) });
    result.clear();
  }
  return result;
}

export type WindowPositionRow = {
  icao24: string; latitude: number; longitude: number; observed_at: Date;
  altitude_ft: number | null; ground_speed_kt: number | null; track_deg: number | null; vertical_rate_fpm: number | null;
};

/**
 * Window scope: scores aircraft from positions already loaded for the visit count. All visits share the query
 * center, so the location-correlation pass cannot fire here (it needs the saved log).
 */
export function assessWindowPatterns(aircraft: readonly NettedAircraft[], rows: readonly WindowPositionRow[], center: { latitude: number; longitude: number }, radiusNm: number): Map<string, PatternAssessment> {
  const inside = new Map<string, PatternPosition[]>();
  for (const row of rows) {
    if (distanceNm(center.latitude, center.longitude, row.latitude, row.longitude) > radiusNm) continue;
    const list = inside.get(row.icao24) ?? [];
    list.push(toPosition(row));
    inside.set(row.icao24, list);
  }
  const result = new Map<string, PatternAssessment>();
  for (const item of aircraft) {
    const positions = inside.get(item.icao24) ?? [];
    const visits: PatternVisit[] = item.visits.slice(0, 20).map((visit) => {
      const start = Date.parse(visit.enteredAt);
      const end = Date.parse(visit.lastSeenInRadiusAt);
      return {
        enteredAt: visit.enteredAt,
        lastSeenInRadiusAt: visit.lastSeenInRadiusAt,
        center,
        positions: positions.filter((p) => { const t = Date.parse(p.observedAt); return t >= start && t <= end; }),
      };
    });
    result.set(item.icao24, assessPattern({ icao24: item.icao24, callsign: item.callsign, registration: item.registration ?? item.registryRegistration ?? null, aircraftTypeCode: item.aircraftTypeCode, visitCount: item.visitCount, visits, centers: [] }));
  }
  return result;
}
