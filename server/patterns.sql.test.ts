import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NettedAircraft } from "../src/domain/netted.js";
import type { Queryable } from "./db.js";
import { assessLogPatterns, loadProviderFlags } from "./patterns.js";

// SYNTHETIC TEST VECTORS ONLY (invented aircraft, users and coordinates), in an ephemeral WASM PostgreSQL instance
// carrying the real 0006 (encounters) and 0007 (center_mode, control circles) DDL.
let pg: PGlite;
const db: Queryable = { query: <Row extends QueryResultRow>(text: string, params?: readonly unknown[]) => pg.query<Row>(text, [...(params ?? [])]) as never };
const user = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
const HOME = { latitude: 40, longitude: -86 };
const WORK = { latitude: 40.4, longitude: -86.9 };
const minute = (day: number, m: number) => new Date(Date.UTC(2026, 10, day, 15, 0) + m * 60_000);
let positionId = 1;

async function addAircraft(icao24: string, index: number) {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  await pg.query("insert into public.aircraft (id, icao24, registration) values ($1, $2, null)", [id, icao24]);
  return id;
}
async function addPositions(aircraftId: string, day: number, minutes: number, stepSec: number, orbit: boolean, payload: Record<string, unknown> = {}) {
  for (let s = 0; s <= minutes * 60; s += stepSec) {
    const angle = (s * 1 * Math.PI) / 180; // 1°/s orbit
    const lat = HOME.latitude + (orbit ? 1.6 * Math.cos(angle) / 60 : (s / 3600) * 110 / 60);
    const lon = HOME.longitude + (orbit ? 1.6 * Math.sin(angle) / (60 * Math.cos((HOME.latitude * Math.PI) / 180)) : 0);
    const id = positionId++;
    await pg.query(
      "insert into public.aircraft_positions (id, aircraft_id, observed_at, latitude, longitude, altitude_ft, ground_speed_kt, track_deg, vertical_rate_fpm) values ($1, $2, $3, $4, $5, 2000, 100, null, 0)",
      [id, aircraftId, new Date(minute(day, 0).getTime() + s * 1000).toISOString(), lat, lon],
    );
    await pg.query("insert into airintel_private.raw_observations (id, position_id, payload) values ($1, $1, $2::jsonb)", [id, JSON.stringify({ hex: "x", ...payload })]);
  }
}
async function addEncounter(userId: string, icao24: string, day: number, minutes: number, center = HOME, mode: string | null = "follow", start = 0) {
  await pg.query(
    `insert into airintel_private.encounters (user_id, icao24, entered_at, last_seen_in_radius_at, closest_approach_nm, observation_count, center_latitude, center_longitude, radius_nm, source, algorithm_version, center_mode)
     values ($1, $2, $3, $4, 0.5, 2, $5, $6, 6.1, 'sweep', 'netted-visits-v1', $7)`,
    [userId, icao24, minute(day, start).toISOString(), minute(day, start + minutes).toISOString(), center.latitude, center.longitude, mode],
  );
}
const netted = (icao24: string, visitCount: number, callsign: string | null = "N1TEST"): NettedAircraft => ({ icao24, callsign, registration: "N1TEST", aircraftTypeCode: null, visitCount, firstSeenAt: minute(1, 0).toISOString(), lastSeenAt: minute(5, 0).toISOString(), closestApproachMi: 0.5, visits: [] });

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`create schema airintel_private;
    create table public.aircraft (id uuid primary key, icao24 text unique, registration text);
    create table public.aircraft_positions (id bigint primary key, aircraft_id uuid references public.aircraft(id), observed_at timestamptz, latitude double precision, longitude double precision, altitude_ft double precision, ground_speed_kt double precision, track_deg double precision, vertical_rate_fpm double precision);
    create table airintel_private.raw_observations (id bigint primary key, position_id bigint unique references public.aircraft_positions(id), payload jsonb not null);
    create table airintel_private.net_watch_areas (user_id uuid primary key);`);
  await pg.exec(readFileSync(new URL("../db/migrations/0006_account_encounters.sql", import.meta.url), "utf8"));
  await pg.exec(readFileSync(new URL("../db/migrations/0007_follow_me_and_control_circles.sql", import.meta.url), "utf8"));

  // aaa001: orbits over home on 3 days, each 20 min sampled every 60 s, flagged military in the provider database.
  const orbiter = await addAircraft("aaa001", 1);
  for (const day of [1, 2, 3]) { await addPositions(orbiter, day, 20, 60, true, { dbFlags: 1, category: "A1" }); await addEncounter(user, "aaa001", day, 20); }
  // aaa002: one long 4-hour loiter sampled every 10 s (1,441 positions) -> must be downsampled, not truncated.
  const loiterer = await addAircraft("aaa002", 2);
  await addPositions(loiterer, 4, 240, 10, true);
  await addEncounter(user, "aaa002", 4, 240);
  // aaa003: two straight passes 2 h apart, one at home and one at work -> time-correlated locations.
  const commuter = await addAircraft("aaa003", 3);
  await addPositions(commuter, 5, 4, 60, false);
  await addEncounter(user, "aaa003", 5, 4, HOME);
  await addEncounter(user, "aaa003", 5, 4, WORK, "follow", 120);
  // Another account's encounters never leak into this user's scoring.
  await addEncounter(other, "aaa003", 5, 30, { latitude: 41.5, longitude: -84 });
}, 60_000);
afterAll(async () => { await pg?.close(); });

describe("assessLogPatterns (scoring data loader)", () => {
  it("loads positions per encounter, provider flags and time-aware sightings, and scores them", async () => {
    const { assessments, status } = await assessLogPatterns(db, user, [netted("aaa001", 3), netted("aaa002", 1), netted("aaa003", 2)]);
    expect(status).toEqual({ state: "ok", detail: null });
    const orbiter = assessments.get("aaa001")!;
    expect(orbiter.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["circling", "loiter", "military_flag"]));
    expect(orbiter.coverage).toBe("ok");
    const commuter = assessments.get("aaa003")!;
    expect(commuter.reasons.map((r) => r.code)).toContain("followed_locations");
  });

  it("downsamples very long visits instead of cutting off later aircraft", async () => {
    const { assessments } = await assessLogPatterns(db, user, [netted("aaa002", 1)], { positionsPerVisit: 100 });
    const loiterer = assessments.get("aaa002")!;
    expect(loiterer.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["downsampled", "circling", "loiter"]));
  });

  it("reports a failure instead of silently returning no flags", async () => {
    const broken: Queryable = { query: async () => { throw Object.assign(new Error("timeout"), { code: "57014" }); } };
    const { assessments, status } = await assessLogPatterns(broken, user, [netted("aaa001", 3)]);
    expect(assessments.size).toBe(0);
    expect(status.state).toBe("failed");
    expect(status.detail).toMatch(/could not be scored/i);
  });

  it("reports partial scoring when only the identity lookups fail", async () => {
    const flaky: Queryable = { query: (text, params) => (/raw_observations/.test(text) ? Promise.reject(new Error("boom")) : db.query(text, params)) };
    const { assessments, status } = await assessLogPatterns(flaky, user, [netted("aaa001", 3)]);
    expect(assessments.get("aaa001")?.reasons.some((r) => r.code === "circling")).toBe(true);
    expect(status.state).toBe("partial");
  });
});

describe("loadProviderFlags", () => {
  it("reads adsb.lol dbFlags and category from the retained raw payloads", async () => {
    const flags = await loadProviderFlags(db, ["aaa001", "aaa003", "ffffff"]);
    expect(flags.get("aaa001")).toEqual({ dbFlags: 1, category: "A1" });
    expect(flags.get("aaa003")).toEqual({ dbFlags: 0, category: null });
    expect(flags.has("ffffff")).toBe(false);
  });
});
