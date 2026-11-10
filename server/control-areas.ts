import { distanceNm } from "../src/domain/geometry.js";
import type { z } from "zod";
import { CONTROL_WINDOW_DAYS, MIN_CONTROL_SEPARATION_MI, type ControlArea, type ControlAreasResponse, type controlAreaInputSchema } from "../src/domain/net.js";
import { milesToNm, nmToMiles } from "../src/domain/units.js";
import { iso, type Queryable } from "./db.js";

/**
 * Control circles (migration 0007): up to two fixed circles per account that the user does NOT go to. The always-on
 * sweep counts the distinct aircraft seen inside each one per UTC day (airintel_private.control_sightings). Comparing
 * an aircraft's days at the controls with its days near the user separates common local traffic from aircraft that
 * show up specifically where the user is. Like every airintel_private table, nothing here is browser-readable.
 */

type ControlRow = {
  id: string; user_id: string; slot: number; label: string; latitude: number; longitude: number; radius_mi: number; enabled: boolean;
  updated_at: Date; last_success_at: Date | null; aircraft_seen?: number;
};

export type ControlSweepArea = { kind: "control"; controlId: string; userId: string; latitude: number; longitude: number; radiusMi: number };
export type ControlObservation = { icao24: string; observedAt: string; latitude: number; longitude: number };

const isUndefinedTable = (error: unknown) => (error as { code?: unknown } | null)?.code === "42P01";

const toDto = (row: ControlRow): ControlArea => ({
  slot: row.slot,
  label: row.label,
  latitude: row.latitude,
  longitude: row.longitude,
  radiusMi: row.radius_mi,
  enabled: row.enabled,
  updatedAt: iso(row.updated_at)!,
  lastSuccessAt: iso(row.last_success_at),
  aircraftSeen: Number(row.aircraft_seen ?? 0),
});

/** The caller's control circles with per-circle counts and the matching count for their own log, over CONTROL_WINDOW_DAYS. */
export async function listControlAreas(db: Queryable, userId: string, now: Date = new Date()): Promise<ControlAreasResponse> {
  const [areas, yours] = await Promise.all([
    db.query<ControlRow>(
      `select c.id, c.user_id, c.slot, c.label, c.latitude, c.longitude, c.radius_mi, c.enabled, c.updated_at, c.last_success_at,
              (select count(distinct s.icao24)::int from airintel_private.control_sightings s
                where s.control_area_id = c.id and s.day >= (now() at time zone 'utc')::date - $2::integer) as aircraft_seen
         from airintel_private.net_control_areas c
        where c.user_id = $1::uuid
        order by c.slot`,
      [userId, CONTROL_WINDOW_DAYS - 1],
    ),
    db.query<{ seen: number }>(
      `select count(distinct icao24)::int as seen from airintel_private.encounters
        where user_id = $1::uuid and entered_at >= now() - make_interval(days => $2::integer)`,
      [userId, CONTROL_WINDOW_DAYS],
    ),
  ]);
  return { controlAreas: areas.rows.map(toDto), yourAircraftSeen: Number(yours.rows[0]?.seen ?? 0), windowDays: CONTROL_WINDOW_DAYS, receivedAt: now.toISOString() };
}

export class ControlTooCloseError extends Error {
  constructor(readonly distanceMi: number) { super("control_too_close"); this.name = "ControlTooCloseError"; }
}

/** True when a control center is too close to the user's own watch center to act as a comparison. */
export function controlTooClose(control: { latitude: number; longitude: number }, watch: { latitude: number; longitude: number } | null): number | null {
  if (!watch) return null;
  const miles = nmToMiles(distanceNm(control.latitude, control.longitude, watch.latitude, watch.longitude));
  return miles < MIN_CONTROL_SEPARATION_MI ? miles : null;
}

/**
 * Saves the control circle in `input.slot`. Moving it or changing its radius clears its success marker and its old
 * sightings (they described a different place). Rejects a center within MIN_CONTROL_SEPARATION_MI of the user's
 * saved watch center: a control that overlaps "where I am" cannot serve as a comparison.
 */
export async function upsertControlArea(db: Queryable, userId: string, input: z.output<typeof controlAreaInputSchema>): Promise<void> {
  const { rows: watch } = await db.query<{ latitude: number; longitude: number }>(
    "select latitude, longitude from airintel_private.net_watch_areas where user_id = $1::uuid", [userId],
  );
  const close = controlTooClose(input, watch[0] ?? null);
  if (close !== null) throw new ControlTooCloseError(close);
  const { rows } = await db.query<{ id: string; moved: boolean }>(
    `with previous as (
       select id, latitude, longitude, radius_mi from airintel_private.net_control_areas where user_id = $1::uuid and slot = $2
     )
     insert into airintel_private.net_control_areas as c (user_id, slot, label, latitude, longitude, radius_mi, enabled)
     values ($1::uuid, $2, $3, $4, $5, $6, $7)
     on conflict (user_id, slot) do update set
       label = excluded.label, latitude = excluded.latitude, longitude = excluded.longitude, radius_mi = excluded.radius_mi,
       enabled = excluded.enabled, updated_at = now(),
       last_success_at = case when c.latitude = excluded.latitude and c.longitude = excluded.longitude and c.radius_mi = excluded.radius_mi then c.last_success_at else null end
     returning c.id, coalesce((select p.latitude <> $4 or p.longitude <> $5 or p.radius_mi <> $6 from previous p), false) as moved`,
    [userId, input.slot, input.label, input.latitude, input.longitude, input.radiusMi, input.enabled],
  );
  const saved = rows[0];
  if (saved?.moved) await db.query("delete from airintel_private.control_sightings where control_area_id = $1::uuid", [saved.id]);
}

export async function deleteControlArea(db: Queryable, userId: string, slot: number): Promise<void> {
  await db.query("delete from airintel_private.net_control_areas where user_id = $1::uuid and slot = $2", [userId, slot]);
}

/** Enabled control circles due for a sweep. Returns [] when migration 0007 is not applied, so the net keeps working. */
export async function loadDueControlAreas(db: Queryable, options: { minIntervalSeconds: number; limit: number }): Promise<ControlSweepArea[]> {
  try {
    const { rows } = await db.query<ControlRow>(
      `select id, user_id, latitude, longitude, radius_mi
         from airintel_private.net_control_areas
        where enabled and (last_polled_at is null or last_polled_at < now() - make_interval(secs => $1::double precision))
        order by last_polled_at nulls first, id
        limit $2::integer`,
      [options.minIntervalSeconds, options.limit],
    );
    return rows.map((row) => ({ kind: "control", controlId: row.id, userId: row.user_id, latitude: row.latitude, longitude: row.longitude, radiusMi: row.radius_mi }));
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    throw error;
  }
}

export async function markControlAreasPolled(db: Queryable, ids: readonly string[], status: string, success: boolean): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `update airintel_private.net_control_areas
        set last_polled_at = now(), last_poll_status = $2, last_success_at = case when $3::boolean then now() else last_success_at end
      where id = any($1::uuid[])`,
    [ids, status.slice(0, 64), success],
  );
}

export type SightingAggregate = { icao24: string; day: string; count: number; firstSeenAt: string; lastSeenAt: string; closestNm: number };

/** Pure: per (aircraft, UTC day) aggregate of the observations inside the control circle. */
export function aggregateSightings(area: { latitude: number; longitude: number; radiusMi: number }, observations: readonly ControlObservation[]): SightingAggregate[] {
  const radiusNm = milesToNm(area.radiusMi);
  const byKey = new Map<string, SightingAggregate>();
  for (const observation of observations) {
    const icao24 = observation.icao24.trim().toLowerCase();
    const time = Date.parse(observation.observedAt);
    if (!/^[0-9a-f]{6}$/.test(icao24) || !Number.isFinite(time)) continue;
    const distance = distanceNm(area.latitude, area.longitude, observation.latitude, observation.longitude);
    if (distance > radiusNm) continue;
    const at = new Date(time).toISOString();
    const day = at.slice(0, 10);
    const key = `${icao24}:${day}`;
    const current = byKey.get(key);
    if (!current) { byKey.set(key, { icao24, day, count: 1, firstSeenAt: at, lastSeenAt: at, closestNm: distance }); continue; }
    current.count += 1;
    if (at < current.firstSeenAt) current.firstSeenAt = at;
    if (at > current.lastSeenAt) current.lastSeenAt = at;
    current.closestNm = Math.min(current.closestNm, distance);
  }
  return [...byKey.values()];
}

/** Upserts the day aggregates for one control circle. Returns the number of (aircraft, day) rows touched. */
export async function recordControlSightings(db: Queryable, area: ControlSweepArea, observations: readonly ControlObservation[]): Promise<number> {
  const rows = aggregateSightings(area, observations);
  if (rows.length === 0) return 0;
  await db.query(
    `insert into airintel_private.control_sightings as s (control_area_id, icao24, day, observation_count, first_seen_at, last_seen_at, closest_approach_nm)
     select $1::uuid, r.icao24, r.day::date, r.count, r.first_seen_at::timestamptz, r.last_seen_at::timestamptz, r.closest_nm
       from jsonb_to_recordset($2::jsonb) as r(icao24 text, day text, count integer, first_seen_at text, last_seen_at text, closest_nm double precision)
     on conflict (control_area_id, icao24, day) do update set
       observation_count = s.observation_count + excluded.observation_count,
       first_seen_at = least(s.first_seen_at, excluded.first_seen_at),
       last_seen_at = greatest(s.last_seen_at, excluded.last_seen_at),
       closest_approach_nm = least(s.closest_approach_nm, excluded.closest_approach_nm)`,
    [area.controlId, JSON.stringify(rows.map((row) => ({ icao24: row.icao24, day: row.day, count: row.count, first_seen_at: row.firstSeenAt, last_seen_at: row.lastSeenAt, closest_nm: row.closestNm })))],
  );
  return rows.length;
}

export type ControlComparison = { activeCircles: number; daysAtControls: number };

/**
 * Per aircraft: days seen at any of the user's control circles over `windowDays`, plus how many of the user's circles
 * have actually been swept (a control that never ran says nothing). Empty map when migration 0007 is missing.
 */
export async function loadControlComparison(db: Queryable, userId: string, icaos: readonly string[], windowDays = 30): Promise<Map<string, ControlComparison>> {
  const result = new Map<string, ControlComparison>();
  if (icaos.length === 0) return result;
  try {
    const { rows } = await db.query<{ icao24: string | null; active: number; days: number }>(
      `with mine as (
         select id from airintel_private.net_control_areas where user_id = $1::uuid and enabled and last_success_at is not null
       )
       select s.icao24, (select count(*)::int from mine) as active, count(distinct s.day)::int as days
         from airintel_private.control_sightings s
        where s.control_area_id in (select id from mine) and s.icao24 = any($2::text[])
          and s.day >= (now() at time zone 'utc')::date - $3::integer
        group by s.icao24
       union all
       select null, (select count(*)::int from mine), 0`,
      [userId, icaos, windowDays - 1],
    );
    const active = Number(rows[0]?.active ?? 0);
    if (active === 0) return result;
    for (const icao24 of icaos) result.set(icao24, { activeCircles: active, daysAtControls: 0 });
    for (const row of rows) if (row.icao24) result.set(row.icao24, { activeCircles: active, daysAtControls: Number(row.days) });
  } catch (error) {
    if (!isUndefinedTable(error)) throw error;
  }
  return result;
}
