import { distanceNm } from "../src/domain/geometry.js";
import { NETTED_ALGORITHM_VERSION } from "../src/domain/netted.js";
import { VISIT_GAP_MINUTES } from "../src/domain/units.js";
import type { Queryable } from "./db.js";
import { errorFields, log } from "./logger.js";

/**
 * Per-account encounter log (migration 0006). After the live view or the sweep records observations, this advances
 * each affected user's encounter state incrementally with the same rule as `netted-visits-v1`
 * (src/domain/netted.ts): an observation inside the radius starts a NEW encounter when it is the first one ever seen
 * for that user and aircraft, when the previous observation was outside the radius, or when more than
 * VISIT_GAP_MINUTES passed since the previous observation. Otherwise it continues the open encounter.
 *
 * Writes are guarded per (user, aircraft) by `last_observed_at`: the tally row is claimed with a compare-and-set
 * before any encounter is written, so overlapping writers (two tabs, live + sweep) never double count, and
 * observations at or before the processed watermark are ignored (idempotent replays).
 */

export type EncounterArea = { latitude: number; longitude: number; radiusNm: number };
export type EncounterSource = "live" | "sweep";
export type EncounterObservation = { icao24: string; observedAt: string; latitude: number; longitude: number; callsign?: string | null | undefined; registration?: string | null | undefined };

/** Detection state carried between batches (one tally row). */
export type EncounterState = { lastObservedAt: number | null; lastInside: boolean; openEncounterId: string | null };

export type EncounterSegment = { enteredAt: number; lastSeenAt: number; closestNm: number; observationCount: number; callsign: string | null; registration: string | null };

export type EncounterAdvance = {
  /** Observations folded into the already-open encounter (null when none). */
  continued: Omit<EncounterSegment, "enteredAt"> | null;
  /** New encounters, oldest first. */
  started: EncounterSegment[];
  /** Watermark and inside flag after this batch; null when no observation was newer than the watermark. */
  next: { lastObservedAt: number; lastInside: boolean; openIsLastStarted: boolean; closesOpen: boolean } | null;
};

const clip = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 16) : null;
};

/** Pure: folds one aircraft's new observations (any order) into its encounter state. */
export function advanceEncounters(state: EncounterState, observations: readonly EncounterObservation[], area: EncounterArea, gapMinutes = VISIT_GAP_MINUTES): EncounterAdvance {
  const gapMs = gapMinutes * 60_000;
  const fresh = observations
    .map((observation) => ({ observation, time: Date.parse(observation.observedAt) }))
    .filter(({ time }) => Number.isFinite(time) && (state.lastObservedAt === null || time > state.lastObservedAt))
    .sort((a, b) => a.time - b.time);
  const result: EncounterAdvance = { continued: null, started: [], next: null };
  if (fresh.length === 0) return result;

  let previous: { time: number; inside: boolean } | null = state.lastObservedAt === null ? null : { time: state.lastObservedAt, inside: state.lastInside };
  // The segment that observations currently extend: "open" (the encounter already in the database) or a new one.
  let current: "open" | EncounterSegment | null = state.openEncounterId && state.lastInside ? "open" : null;
  let closesOpen = false;
  for (const { observation, time } of fresh) {
    const distance = distanceNm(area.latitude, area.longitude, observation.latitude, observation.longitude);
    const inside = distance <= area.radiusNm;
    if (inside) {
      const starts = previous === null || !previous.inside || time - previous.time > gapMs;
      if (starts) {
        if (current === "open") closesOpen = true;
        current = { enteredAt: time, lastSeenAt: time, closestNm: distance, observationCount: 0, callsign: null, registration: null };
        result.started.push(current);
      }
      if (current === "open") {
        const continued = result.continued ?? { lastSeenAt: time, closestNm: distance, observationCount: 0, callsign: null, registration: null };
        continued.lastSeenAt = time;
        continued.closestNm = Math.min(continued.closestNm, distance);
        continued.observationCount += 1;
        continued.callsign = clip(observation.callsign) ?? continued.callsign;
        continued.registration = clip(observation.registration) ?? continued.registration;
        result.continued = continued;
      } else if (current) {
        current.lastSeenAt = time;
        current.closestNm = Math.min(current.closestNm, distance);
        current.observationCount += 1;
        current.callsign = clip(observation.callsign) ?? current.callsign;
        current.registration = clip(observation.registration) ?? current.registration;
      }
    } else {
      if (current === "open") closesOpen = true;
      current = null;
    }
    previous = { time, inside };
  }
  const last = fresh[fresh.length - 1]!;
  const lastInside = previous!.inside;
  result.next = {
    lastObservedAt: last.time,
    lastInside,
    openIsLastStarted: lastInside && current !== null && current !== "open",
    closesOpen: closesOpen || (!lastInside && state.openEncounterId !== null),
  };
  return result;
}

type TallyRow = { icao24: string; last_observed_at: Date | null; last_inside: boolean; open_encounter_id: string | null };
export type EncounterWriteResult = { aircraft: number; started: number; continued: number; skipped: number };

const ts = (value: number) => new Date(value).toISOString();

/**
 * Advances `userId`'s encounter log with observations measured against `area`. Never throws: a failure is logged
 * and reported as skipped so the recording that triggered it is unaffected.
 */
export async function recordEncounters(db: Queryable, userId: string, area: EncounterArea, observations: readonly EncounterObservation[], source: EncounterSource): Promise<EncounterWriteResult> {
  const result: EncounterWriteResult = { aircraft: 0, started: 0, continued: 0, skipped: 0 };
  const byAircraft = new Map<string, EncounterObservation[]>();
  for (const observation of observations) {
    const icao24 = observation.icao24.trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(icao24)) continue;
    const list = byAircraft.get(icao24);
    if (list) list.push(observation); else byAircraft.set(icao24, [observation]);
  }
  if (byAircraft.size === 0) return result;
  try {
    const { rows } = await db.query<TallyRow>(
      `select icao24, last_observed_at, last_inside, open_encounter_id
         from airintel_private.user_aircraft_tallies where user_id = $1::uuid and icao24 = any($2::text[])`,
      [userId, [...byAircraft.keys()]],
    );
    const tallies = new Map(rows.map((row) => [row.icao24, row]));
    for (const [icao24, list] of byAircraft) {
      const tally = tallies.get(icao24) ?? null;
      const state: EncounterState = { lastObservedAt: tally?.last_observed_at ? tally.last_observed_at.getTime() : null, lastInside: tally?.last_inside ?? false, openEncounterId: tally?.open_encounter_id ?? null };
      const advance = advanceEncounters(state, list, area);
      // Aircraft never seen inside this user's radius get no rows at all.
      if (!advance.next || (!tally && advance.started.length === 0)) continue;
      try {
        await applyAdvance(db, userId, icao24, area, source, tally, state, advance);
        result.aircraft += 1;
        result.started += advance.started.length;
        if (advance.continued) result.continued += 1;
      } catch (error) {
        if (error instanceof ClaimLost) { result.skipped += 1; continue; }
        throw error;
      }
    }
  } catch (error) {
    if (!(error && typeof error === "object" && (error as { code?: unknown }).code === "42P01")) log("error", "encounter_write_failed", { source, ...errorFields(error) });
    result.skipped += 1;
  }
  return result;
}

class ClaimLost extends Error {}

async function applyAdvance(db: Queryable, userId: string, icao24: string, area: EncounterArea, source: EncounterSource, tally: TallyRow | null, state: EncounterState, advance: EncounterAdvance) {
  const next = advance.next!;
  // 1. Claim: move the watermark only if nobody else moved it since we read it.
  const claim = tally
    ? await db.query(
      `update airintel_private.user_aircraft_tallies set last_observed_at = $3, last_inside = $4, updated_at = now()
        where user_id = $1::uuid and icao24 = $2 and last_observed_at is not distinct from $5::timestamptz returning icao24`,
      [userId, icao24, ts(next.lastObservedAt), next.lastInside, state.lastObservedAt === null ? null : ts(state.lastObservedAt)],
    )
    : await db.query(
      `insert into airintel_private.user_aircraft_tallies (user_id, icao24, last_observed_at, last_inside)
       values ($1::uuid, $2, $3, $4) on conflict (user_id, icao24) do nothing returning icao24`,
      [userId, icao24, ts(next.lastObservedAt), next.lastInside],
    );
  if (claim.rows.length !== 1) throw new ClaimLost();

  // 2. Extend the open encounter.
  if (advance.continued && state.openEncounterId) {
    const c = advance.continued;
    await db.query(
      `update airintel_private.encounters
          set last_seen_in_radius_at = greatest(last_seen_in_radius_at, $2), closest_approach_nm = least(closest_approach_nm, $3),
              observation_count = observation_count + $4, callsign = coalesce($5, callsign), registration = coalesce($6, registration), updated_at = now()
        where id = $1::uuid`,
      [state.openEncounterId, ts(c.lastSeenAt), c.closestNm, c.observationCount, c.callsign, c.registration],
    );
  }

  // 3. Insert new encounters.
  let lastId: string | null = null;
  for (const segment of advance.started) {
    const { rows } = await db.query<{ id: string }>(
      `insert into airintel_private.encounters
         (user_id, icao24, callsign, registration, entered_at, last_seen_in_radius_at, closest_approach_nm, observation_count,
          center_latitude, center_longitude, radius_nm, source, algorithm_version)
       values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [userId, icao24, segment.callsign, segment.registration, ts(segment.enteredAt), ts(segment.lastSeenAt), segment.closestNm, segment.observationCount,
        area.latitude, area.longitude, area.radiusNm, source, NETTED_ALGORITHM_VERSION],
    );
    lastId = rows[0]?.id ?? null;
  }

  // 4. Update the lifetime tally.
  const segments = [...advance.started, ...(advance.continued ? [advance.continued] : [])];
  const insideTimes = segments.map((segment) => segment.lastSeenAt);
  const closest = segments.length > 0 ? Math.min(...segments.map((segment) => segment.closestNm)) : null;
  const newest = [...segments].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
  const openId = next.openIsLastStarted ? lastId : next.closesOpen ? null : state.openEncounterId;
  await db.query(
    `update airintel_private.user_aircraft_tallies
        set encounter_count = encounter_count + $3,
            first_encountered_at = coalesce(first_encountered_at, $4::timestamptz),
            last_encountered_at = coalesce($5::timestamptz, last_encountered_at),
            last_seen_in_radius_at = case when $6::timestamptz is null then last_seen_in_radius_at else greatest(last_seen_in_radius_at, $6::timestamptz) end,
            closest_approach_nm = case when $7::double precision is null then closest_approach_nm else least(coalesce(closest_approach_nm, $7::double precision), $7::double precision) end,
            last_callsign = coalesce($8, last_callsign),
            last_registration = coalesce($9, last_registration),
            open_encounter_id = $10::uuid,
            updated_at = now()
      where user_id = $1::uuid and icao24 = $2`,
    [userId, icao24, advance.started.length,
      advance.started[0] ? ts(advance.started[0].enteredAt) : null,
      advance.started.length > 0 ? ts(advance.started[advance.started.length - 1]!.enteredAt) : null,
      insideTimes.length > 0 ? ts(Math.max(...insideTimes)) : null,
      closest,
      newest?.callsign ?? null, newest?.registration ?? null,
      openId],
  );
}
