import { distanceNm } from "../src/domain/geometry.js";
import type { NettedAircraft } from "../src/domain/netted.js";
import { assessPattern, type CenterMode, type PatternAssessment, type PatternIdentity, type PatternPosition, type PatternSighting, type PatternVisit } from "../src/domain/patterns.js";
import { iso, type Queryable } from "./db.js";
import { loadControlComparison, type ControlComparison } from "./control-areas.js";
import { errorFields, log } from "./logger.js";
import type { RegistryIdentity } from "./registry.js";

/** Newest encounters per aircraft whose positions are loaded for pattern scoring. */
export const PATTERN_VISITS_PER_AIRCRAFT = 20;
/** Longer visits are evenly downsampled to this many positions (keeps the whole visit's shape and duration). */
export const PATTERN_POSITIONS_PER_VISIT = 180;
/** Saved encounters per aircraft used for the time-aware location pass. */
export const PATTERN_SIGHTINGS_PER_AIRCRAFT = 500;
/** Aircraft scored per database round trip, so one huge list never hits a single global row cap. */
export const PATTERN_CHUNK_SIZE = 40;

/** Whether pattern flags in a response are complete. Shown to the user instead of silently dropping flags. */
export type PatternRunStatus = { state: "ok" | "partial" | "failed"; detail: string | null };
export type PatternRun = { assessments: Map<string, PatternAssessment>; status: PatternRunStatus };

type PositionRow = {
  encounter_id: string; icao24: string; entered_at: Date; last_seen_in_radius_at: Date; center_latitude: number; center_longitude: number;
  total: number | string | null; observed_at: Date | null; latitude: number | null; longitude: number | null; altitude_ft: number | null; ground_speed_kt: number | null;
  track_deg: number | null; vertical_rate_fpm: number | null; on_ground: boolean | null;
};

const toPosition = (row: { observed_at: Date; latitude: number; longitude: number; altitude_ft: number | null; ground_speed_kt: number | null; track_deg: number | null; vertical_rate_fpm: number | null; on_ground?: boolean | null }): PatternPosition => ({
  observedAt: iso(row.observed_at)!,
  latitude: row.latitude,
  longitude: row.longitude,
  altitudeFt: row.altitude_ft,
  groundSpeedKt: row.ground_speed_kt,
  trackDeg: row.track_deg,
  verticalRateFpm: row.vertical_rate_fpm,
  onGround: row.on_ground ?? null,
});

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export type ProviderFlags = { dbFlags: number; category: string | null };

/**
 * adsb.lol database flags (1 military, 2 interesting, 4 PIA, 8 LADD) and ADS-B emitter category, read from the raw
 * provider payloads the recorder already keeps server-side (newest 20 per aircraft, flags OR-ed). Throws on failure.
 */
export async function loadProviderFlags(db: Queryable, icaos: readonly string[]): Promise<Map<string, ProviderFlags>> {
  const result = new Map<string, ProviderFlags>();
  for (const chunk of chunks(icaos, PATTERN_CHUNK_SIZE)) {
    const { rows } = await db.query<{ icao24: string; flags: number | null; category: string | null; payloads: number }>(
      `select a.icao24, f.flags, f.category, f.payloads
         from public.aircraft a
         cross join lateral (
           select bit_or(case when jsonb_typeof(o.payload -> 'dbFlags') = 'number' then (o.payload ->> 'dbFlags')::int else 0 end) as flags,
                  max(nullif(o.payload ->> 'category', '')) as category, count(o.id)::int as payloads
             from (select pp.id from public.aircraft_positions pp where pp.aircraft_id = a.id order by pp.observed_at desc limit 20) lp
             join airintel_private.raw_observations o on o.position_id = lp.id
         ) f
        where a.icao24 = any($1::text[])`,
      [chunk],
    );
    for (const row of rows) if (Number(row.payloads) > 0) result.set(row.icao24, { dbFlags: Number(row.flags ?? 0), category: row.category ?? null });
  }
  return result;
}

export const toPatternIdentity = (registry: RegistryIdentity | undefined, flags: ProviderFlags | undefined): PatternIdentity => ({
  dbFlags: flags?.dbFlags ?? null,
  category: flags?.category ?? null,
  registrantKind: registry?.registrantKind ?? null,
  registrantName: registry?.registrantName ?? null,
  faaAircraftType: registry?.faaAircraftType ?? null,
});

const describeFailures = (failed: number, total: number, notes: string[]): PatternRunStatus => {
  if (total > 0 && failed >= total) return { state: "failed", detail: "Pattern flags could not be scored right now (database error). The list is shown without them." };
  const parts = [...(failed > 0 ? [`${failed} of ${total} aircraft could not be scored`] : []), ...notes];
  return parts.length > 0 ? { state: "partial", detail: `Pattern flags are incomplete: ${parts.join("; ")}.` } : { state: "ok", detail: null };
};

/**
 * Log scope: scores the caller's saved aircraft from their own encounters (newest PATTERN_VISITS_PER_AIRCRAFT each,
 * with the recorded positions between entry and last-seen, evenly downsampled past PATTERN_POSITIONS_PER_VISIT), their
 * saved encounter times and centers (time-aware location pass), control circles, provider flags and FAA identity.
 * Works in chunks of PATTERN_CHUNK_SIZE aircraft. Never throws; the returned status says what, if anything, is missing.
 */
export async function assessLogPatterns(
  db: Queryable,
  userId: string,
  aircraft: readonly NettedAircraft[],
  options: { registry?: Map<string, RegistryIdentity>; positionsPerVisit?: number } = {},
): Promise<PatternRun> {
  const assessments = new Map<string, PatternAssessment>();
  if (aircraft.length === 0) return { assessments, status: { state: "ok", detail: null } };
  const perVisit = Math.max(10, Math.floor(options.positionsPerVisit ?? PATTERN_POSITIONS_PER_VISIT));
  const notes: string[] = [];
  const icaos = aircraft.map((item) => item.icao24);

  const flags = await loadProviderFlags(db, icaos).catch((error: unknown) => {
    log("warn", "pattern_provider_flags_failed", errorFields(error));
    notes.push("provider database flags unavailable");
    return new Map<string, ProviderFlags>();
  });
  const controls = await loadControlComparison(db, userId, icaos).catch((error: unknown) => {
    log("warn", "pattern_control_comparison_failed", errorFields(error));
    notes.push("control-circle comparison unavailable");
    return new Map<string, ControlComparison>();
  });

  let failed = 0;
  for (const chunk of chunks(aircraft, PATTERN_CHUNK_SIZE)) {
    const chunkIcaos = chunk.map((item) => item.icao24);
    try {
      const [positions, sightings] = await Promise.all([
        db.query<PositionRow>(
          `with ranked as (
             select e.id, e.icao24, e.entered_at, e.last_seen_in_radius_at, e.center_latitude, e.center_longitude,
                    row_number() over (partition by e.icao24 order by e.entered_at desc) as rn
               from airintel_private.encounters e
              where e.user_id = $1::uuid and e.icao24 = any($2::text[])
           )
           select r.id as encounter_id, r.icao24, r.entered_at, r.last_seen_in_radius_at, r.center_latitude, r.center_longitude,
                  p.total, p.observed_at, p.latitude, p.longitude, p.altitude_ft, p.ground_speed_kt, p.track_deg, p.vertical_rate_fpm, p.on_ground
             from ranked r
             left join public.aircraft a on a.icao24 = r.icao24
             left join lateral (
               select q.* from (
                 select pp.observed_at, pp.latitude, pp.longitude, pp.altitude_ft, pp.ground_speed_kt, pp.track_deg, pp.vertical_rate_fpm, pp.on_ground,
                        row_number() over (order by pp.observed_at) as n, count(*) over () as total
                   from public.aircraft_positions pp
                  where pp.aircraft_id = a.id and pp.observed_at >= r.entered_at and pp.observed_at <= r.last_seen_in_radius_at
               ) q
               where (q.n - 1) % greatest(1, ceil(q.total::numeric / $4::integer)::integer) = 0
             ) p on true
            where r.rn <= $3
            order by r.icao24, r.entered_at, p.observed_at`,
          [userId, chunkIcaos, PATTERN_VISITS_PER_AIRCRAFT, perVisit],
        ),
        db.query<{ icao24: string; entered_at: Date; center_latitude: number; center_longitude: number; center_mode: string | null }>(
          // center_mode via to_jsonb so a database without migration 0007 still scores (mode unknown).
          `select s.icao24, s.entered_at, s.center_latitude, s.center_longitude, to_jsonb(s) ->> 'center_mode' as center_mode
             from (select e.*, row_number() over (partition by e.icao24 order by e.entered_at desc) as rn
                     from airintel_private.encounters e
                    where e.user_id = $1::uuid and e.icao24 = any($2::text[])) s
            where s.rn <= $3`,
          [userId, chunkIcaos, PATTERN_SIGHTINGS_PER_AIRCRAFT],
        ),
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
        if (row.total !== null && Number(row.total) > perVisit) visit.downsampled = true;
        if (row.observed_at && row.latitude !== null && row.longitude !== null) {
          visit.positions.push(toPosition({ ...row, observed_at: row.observed_at, latitude: row.latitude, longitude: row.longitude }));
        }
      }
      const sightingsByAircraft = new Map<string, PatternSighting[]>();
      for (const row of sightings.rows) {
        const list = sightingsByAircraft.get(row.icao24) ?? [];
        const mode: CenterMode | null = row.center_mode === "follow" || row.center_mode === "fixed" ? row.center_mode : null;
        list.push({ enteredAt: iso(row.entered_at)!, latitude: row.center_latitude, longitude: row.center_longitude, centerMode: mode });
        sightingsByAircraft.set(row.icao24, list);
      }
      for (const item of chunk) {
        assessments.set(item.icao24, assessPattern({
          icao24: item.icao24,
          callsign: item.callsign,
          registration: item.registration,
          registryRegistration: item.registryRegistration ?? null,
          aircraftTypeCode: item.aircraftTypeCode,
          visitCount: item.visitCount,
          visits: [...(visitsByAircraft.get(item.icao24)?.values() ?? [])],
          sightings: sightingsByAircraft.get(item.icao24) ?? [],
          control: controls.get(item.icao24),
          identity: toPatternIdentity(options.registry?.get(item.icao24), flags.get(item.icao24)),
        }));
      }
    } catch (error) {
      failed += chunk.length;
      log("error", "pattern_assessment_failed", { scope: "log", aircraft: chunk.length, ...errorFields(error) });
    }
  }
  return { assessments, status: describeFailures(failed, aircraft.length, failed >= aircraft.length ? [] : notes) };
}

export type WindowPositionRow = {
  icao24: string; latitude: number; longitude: number; observed_at: Date;
  altitude_ft: number | null; ground_speed_kt: number | null; track_deg: number | null; vertical_rate_fpm: number | null;
  on_ground?: boolean | null;
};

/**
 * Window scope: scores aircraft from positions already loaded for the visit count. All visits share the query
 * center, so the location-correlation pass cannot fire here (it needs the saved log).
 */
export function assessWindowPatterns(
  aircraft: readonly NettedAircraft[],
  rows: readonly WindowPositionRow[],
  center: { latitude: number; longitude: number },
  radiusNm: number,
  identities: { registry?: Map<string, RegistryIdentity>; flags?: Map<string, ProviderFlags> } = {},
): Map<string, PatternAssessment> {
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
      return { enteredAt: visit.enteredAt, lastSeenInRadiusAt: visit.lastSeenInRadiusAt, center, positions: positions.filter((p) => { const t = Date.parse(p.observedAt); return t >= start && t <= end; }) };
    });
    result.set(item.icao24, assessPattern({
      icao24: item.icao24, callsign: item.callsign, registration: item.registration, registryRegistration: item.registryRegistration ?? null,
      aircraftTypeCode: item.aircraftTypeCode, visitCount: item.visitCount, visits, sightings: [],
      identity: toPatternIdentity(identities.registry?.get(item.icao24), identities.flags?.get(item.icao24)),
    }));
  }
  return result;
}
