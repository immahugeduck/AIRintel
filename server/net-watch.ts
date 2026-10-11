import { deriveNetStatus, type NetStatus, type SavedWatchArea, type WatchAreaInput, type WatchAreaResponse } from "../src/domain/net.js";
import { iso, type Queryable } from "./db.js";

/** Data access for the always-on net (airintel_private.net_watch_areas / net_sweep_state, migration 0005). */

type AreaRow = {
  user_id: string;
  latitude: number;
  longitude: number;
  radius_mi: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  last_polled_at: Date | null;
  last_poll_status: string | null;
  last_success_at: Date | null;
};

const areaColumns = "user_id, latitude, longitude, radius_mi, enabled, created_at, updated_at, last_polled_at, last_poll_status, last_success_at";

const toSaved = (row: AreaRow): SavedWatchArea => ({
  latitude: row.latitude,
  longitude: row.longitude,
  radiusMi: row.radius_mi,
  enabled: row.enabled,
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!,
});

export const toNetStatus = (row: AreaRow | null, now: Date = new Date()): NetStatus =>
  deriveNetStatus(row ? { enabled: row.enabled, updatedAt: iso(row.updated_at), lastSuccessAt: iso(row.last_success_at), lastPolledAt: iso(row.last_polled_at), lastPollStatus: row.last_poll_status } : null, now);

export async function getWatchAreaRow(db: Queryable, userId: string): Promise<AreaRow | null> {
  const { rows } = await db.query<AreaRow>(`select ${areaColumns} from airintel_private.net_watch_areas where user_id = $1::uuid`, [userId]);
  return rows[0] ?? null;
}

export const watchAreaResponse = (row: AreaRow | null, now: Date = new Date()): WatchAreaResponse => ({
  watchArea: row ? toSaved(row) : null,
  net: toNetStatus(row, now),
  receivedAt: now.toISOString(),
});

/**
 * Saves the user's area. A changed location/radius or a (re-)enable clears the success marker so the status
 * honestly returns to "pending" until the next sweep covers the new area.
 */
export async function upsertWatchArea(db: Queryable, userId: string, input: WatchAreaInput): Promise<AreaRow> {
  const { rows } = await db.query<AreaRow>(
    `insert into airintel_private.net_watch_areas as w (user_id, latitude, longitude, radius_mi, enabled)
     values ($1::uuid, $2, $3, $4, $5)
     on conflict (user_id) do update set
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       radius_mi = excluded.radius_mi,
       enabled = excluded.enabled,
       updated_at = now(),
       last_success_at = case
         when w.latitude = excluded.latitude and w.longitude = excluded.longitude and w.radius_mi = excluded.radius_mi and w.enabled = excluded.enabled then w.last_success_at
         else null end,
       last_poll_status = case
         when w.latitude = excluded.latitude and w.longitude = excluded.longitude and w.radius_mi = excluded.radius_mi and w.enabled = excluded.enabled then w.last_poll_status
         else null end
     returning ${areaColumns}`,
    [userId, input.latitude, input.longitude, input.radiusMi, input.enabled],
  );
  return rows[0]!;
}

export type SweepArea = { userId: string; latitude: number; longitude: number; radiusMi: number };

/** Enabled areas not polled within `minIntervalSeconds`, least-recently-polled first (fair rotation when over the cap). */
export async function loadDueAreas(db: Queryable, options: { minIntervalSeconds: number; limit: number }): Promise<SweepArea[]> {
  const { rows } = await db.query<Pick<AreaRow, "user_id" | "latitude" | "longitude" | "radius_mi">>(
    `select user_id, latitude, longitude, radius_mi
       from airintel_private.net_watch_areas
      where enabled and (last_polled_at is null or last_polled_at < now() - make_interval(secs => $1::double precision))
      order by last_polled_at nulls first, user_id
      limit $2::integer`,
    [options.minIntervalSeconds, options.limit],
  );
  return rows.map((row) => ({ userId: row.user_id, latitude: row.latitude, longitude: row.longitude, radiusMi: row.radius_mi }));
}

export async function markAreasPolled(db: Queryable, userIds: readonly string[], status: string, success: boolean): Promise<void> {
  if (userIds.length === 0) return;
  await db.query(
    `update airintel_private.net_watch_areas
        set last_polled_at = now(), last_poll_status = $2, last_success_at = case when $3::boolean then now() else last_success_at end
      where user_id = any($1::uuid[])`,
    [userIds, status.slice(0, 64), success],
  );
}

/**
 * Atomic lease so overlapping sweeps (retries, two schedulers) never double-write. Works through a transaction
 * pooler (unlike session advisory locks). Returns false when another sweep holds an unexpired lease.
 */
export async function acquireSweepLease(db: Queryable, leaseSeconds: number): Promise<boolean> {
  const { rows } = await db.query<{ id: boolean }>(
    `update airintel_private.net_sweep_state
        set locked_until = now() + make_interval(secs => $1::double precision), last_started_at = now()
      where id and (locked_until is null or locked_until <= now())
      returning id`,
    [leaseSeconds],
  );
  return rows.length === 1;
}

export async function releaseSweepLease(db: Queryable, result: { status: string; areasPolled: number; observationsInserted: number }): Promise<void> {
  await db.query(
    `update airintel_private.net_sweep_state
        set locked_until = null, last_finished_at = now(), last_status = $1, last_areas_polled = $2, last_observations_inserted = $3
      where id`,
    [result.status.slice(0, 64), result.areasPolled, result.observationsInserted],
  );
}

export type SweepStateRow = { last_finished_at: Date | null; last_status: string | null; last_purge_at: Date | null; last_purge_deleted: number | null };

export async function getSweepState(db: Queryable): Promise<SweepStateRow | null> {
  const { rows } = await db.query<SweepStateRow>("select last_finished_at, last_status, last_purge_at, last_purge_deleted from airintel_private.net_sweep_state where id", []);
  return rows[0] ?? null;
}

/** Runs one bounded retention batch (migration 0005 helper). Only called when NET_RETENTION_DAYS is set. */
export async function purgeOldObservations(db: Queryable, retentionDays: number, batchSize: number): Promise<number> {
  const { rows } = await db.query<{ deleted: number }>("select airintel_private.purge_aircraft_observations($1::integer, $2::integer) as deleted", [retentionDays, batchSize]);
  const deleted = rows[0]?.deleted ?? 0;
  await db.query("update airintel_private.net_sweep_state set last_purge_at = now(), last_purge_deleted = $1 where id", [deleted]);
  return deleted;
}

export async function hasEnabledAreas(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>("select exists (select 1 from airintel_private.net_watch_areas where enabled) as present", []);
  return rows[0]?.present === true;
}

export type HealthNet = {
  /** idle: nothing enabled · ok: swept within the stale window · stale: enabled areas but no recent sweep · never: enabled but never swept · unknown: not migrated / database unreachable */
  state: "idle" | "ok" | "stale" | "never" | "unknown";
  lastSweepAgeSeconds: number | null;
  /** Machine status of the last sweep run (e.g. completed, partial, failed); no counts, no coordinates. */
  lastStatus: string | null;
};

/** Net freshness for GET /health. Bounded by a short timeout; never throws; leaks no secrets or user data. */
export async function healthNet(db: Queryable, staleAfterMinutes: number, now: Date = new Date(), timeoutMs = 2_000): Promise<HealthNet> {
  const unknown: HealthNet = { state: "unknown", lastSweepAgeSeconds: null, lastStatus: null };
  const work = (async (): Promise<HealthNet> => {
    const [state, enabled] = await Promise.all([getSweepState(db), hasEnabledAreas(db)]);
    const last = state?.last_finished_at ?? null;
    const ageSeconds = last ? Math.max(0, Math.round((now.getTime() - last.getTime()) / 1000)) : null;
    const lastStatus = state?.last_status ?? null;
    if (!enabled) return { state: "idle", lastSweepAgeSeconds: ageSeconds, lastStatus };
    if (ageSeconds === null) return { state: "never", lastSweepAgeSeconds: null, lastStatus };
    return { state: ageSeconds > staleAfterMinutes * 60 ? "stale" : "ok", lastSweepAgeSeconds: ageSeconds, lastStatus };
  })().catch(() => unknown);
  const timeout = new Promise<HealthNet>((resolve) => { setTimeout(() => resolve(unknown), timeoutMs).unref?.(); });
  return Promise.race([work, timeout]);
}
