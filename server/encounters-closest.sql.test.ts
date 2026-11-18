import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable } from "./db.js";
import { recordClosestPoints, recordEncounters } from "./encounters.js";

// SYNTHETIC TEST VECTORS ONLY, in an ephemeral WASM PostgreSQL instance with the real 0006 + 0007 DDL and the column
// part of 0008. (The 0008 backfill needs PostGIS and public.aircraft_positions; it is exercised against Neon instead.)
let pg: PGlite;
const db: Queryable = { query: <Row extends QueryResultRow>(text: string, params?: readonly unknown[]) => pg.query<Row>(text, [...(params ?? [])]) as never };
const user = "44444444-4444-4444-8444-444444444444";
const area = { latitude: 40, longitude: -86, radiusNm: 6 };
const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 15, minute)).toISOString();
const sample = (minute: number, northNm: number, altitudeFt: number) =>
  ({ icao24: "bbb001", observedAt: at(minute), latitude: 40 + northNm / 60, longitude: -86, altitudeFt, altitudeSource: "barometric" as const, groundSpeedKt: 100, trackDeg: 90, verticalRateFpm: 0, onGround: false });

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec("create schema airintel_private;");
  await pg.exec(readFileSync(new URL("../db/migrations/0006_account_encounters.sql", import.meta.url), "utf8"));
  await pg.exec("create table airintel_private.net_watch_areas (user_id uuid primary key);");
  await pg.exec(readFileSync(new URL("../db/migrations/0007_follow_me_and_control_circles.sql", import.meta.url), "utf8"));
  const m8 = readFileSync(new URL("../db/migrations/0008_encounter_closest_point.sql", import.meta.url), "utf8");
  await pg.exec(m8.slice(0, m8.indexOf("-- One-time backfill")));
  const m9 = readFileSync(new URL("../db/migrations/0009_encounter_timing.sql", import.meta.url), "utf8");
  await pg.exec(m9.slice(0, m9.indexOf("-- Snapshots written so far")));
});
afterAll(async () => { await pg.close(); });

const row = async () => (await pg.query<{ closest_approach_nm: number; closest_at: Date; closest_altitude_ft: number; closest_point_basis: string }>(
  "select closest_approach_nm, closest_at, closest_altitude_ft, closest_point_basis from airintel_private.encounters where icao24 = 'bbb001'")).rows;

describe("closest-point writes against real DDL", () => {
  it("stores the closest sample on insert and moves it only when a later batch comes closer", async () => {
    await recordEncounters(db, user, area, [sample(0, 4, 3000), sample(1, 2, 2000)], "sweep");
    let rows = await row();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ closest_altitude_ft: 2000, closest_point_basis: "at_write" });
    expect(rows[0]!.closest_at.toISOString()).toBe(at(1));

    await recordEncounters(db, user, area, [sample(2, 3, 2500)], "live"); // farther: must not overwrite
    rows = await row();
    expect(rows[0]).toMatchObject({ closest_altitude_ft: 2000 });

    await recordEncounters(db, user, area, [sample(3, 1, 1200)], "sweep"); // closer: replaces
    rows = await row();
    expect(rows[0]).toMatchObject({ closest_altitude_ft: 1200 });
    expect(rows[0]!.closest_at.toISOString()).toBe(at(3));
    expect(rows[0]!.closest_approach_nm).toBeCloseTo(1, 2);
  });

  it("stores entry and exit bounds once, including when an open encounter closes in a later batch", async () => {
    const s = (minute: number, northNm: number) => ({ ...sample(minute, northNm, 2000), icao24: "ccc001" });
    await recordEncounters(db, user, area, [s(10, 8), s(11, 3)], "sweep"); // entered, still open
    await recordEncounters(db, user, area, [s(12, 2), s(13, 8)], "sweep"); // left in the next batch
    const { rows } = await pg.query<{ last_outside_before_entry_at: Date; entered_at: Date; last_seen_in_radius_at: Date; first_outside_after_exit_at: Date; closest_center_latitude: number }>(
      "select last_outside_before_entry_at, entered_at, last_seen_in_radius_at, first_outside_after_exit_at, closest_center_latitude from airintel_private.encounters where icao24 = 'ccc001'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_outside_before_entry_at.toISOString()).toBe(at(10));
    expect(rows[0]!.entered_at.toISOString()).toBe(at(11));
    expect(rows[0]!.last_seen_in_radius_at.toISOString()).toBe(at(12));
    expect(rows[0]!.first_outside_after_exit_at.toISOString()).toBe(at(13));
    expect(rows[0]!.closest_center_latitude).toBe(40);
  });

  it("is a silent no-op when the columns do not exist yet (migration 0008 not applied)", async () => {
    const missing: Queryable = { query: async () => { throw Object.assign(new Error('column "closest_at" does not exist'), { code: "42703" }); } };
    await expect(recordClosestPoints(missing, [{ id: "x", distanceNm: 1, point: { at: 0, latitude: 40, longitude: -86, centerLatitude: 40, centerLongitude: -86, altitudeFt: null, altitudeSource: null, groundSpeedKt: null, trackDeg: null, verticalRateFpm: null, onGround: null } }])).resolves.toBeUndefined();
  });
});
