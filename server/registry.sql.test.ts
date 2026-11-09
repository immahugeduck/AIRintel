import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "./db.js";
import { lookupCurrentRegistry } from "./registry.js";

// SYNTHETIC TEST VECTORS ONLY, in an ephemeral WASM PostgreSQL instance.
// Never reads environment credentials, never connects to Neon, never persists real registry data.
const aircraft = { id: "11111111-1111-4111-8111-111111111111", icao24: "abcdef", registration: "N99ZZ" };
const asOf = new Date("2026-11-08T18:00:00Z");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let pg: PGlite;
const db: Queryable = { query: <Row extends QueryResultRow>(text: string, params?: readonly unknown[]) => pg.query<Row>(text, [...(params ?? [])]) };
let sequence = 0;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`create schema airintel_private;
    create table public.aircraft (id uuid primary key, icao24 text, registration text);
    create table public.aircraft_positions (id bigint primary key, aircraft_id uuid references public.aircraft(id));
    create table airintel_private.raw_observations (id bigint primary key, position_id bigint unique references public.aircraft_positions(id), payload jsonb not null);`);
  // Exercise the actual registry DDL, not a hand-maintained approximation.
  await pg.exec(readFileSync(new URL("../db/migrations/0003_phase_three_aircraft_profiles.sql", import.meta.url), "utf8"));
  await pg.query("insert into public.aircraft (id, icao24, registration) values ($1, $2, $3)", [aircraft.id, aircraft.icao24, aircraft.registration]);
}, 30_000);
beforeEach(async () => {
  await pg.exec("truncate public.aircraft_registry_matches, public.aircraft_registry_records, airintel_private.faa_import_runs, public.aircraft_positions, airintel_private.raw_observations cascade");
  await pg.query("insert into public.aircraft_positions (id, aircraft_id) values (10, $1)", [aircraft.id]);
  await pg.query("insert into airintel_private.raw_observations (id, position_id, payload) values (10, 10, $1::jsonb)", [JSON.stringify({ hex: "ABCDEF", type: "adsb_icao" })]);
});
afterAll(async () => { await pg?.close(); });

async function snapshot(date = "2026-11-08", status = "published") {
  const { rows } = await pg.query<{ id: string; date: string }>(
    `insert into airintel_private.faa_import_runs
      (source_url, source_filename, source_sha256, snapshot_date, importer_version, schema_version, status)
     values ('https://www.faa.gov/synthetic-test-vector', 'SYNTHETIC.txt', $1, $2::date, 'test', 'test', $3)
     returning id, snapshot_date::text as date`, [sha(String(sequence++)), date, status]);
  return rows[0]!;
}
async function record(run: { id: string; date: string }, visibility = "displayable_entity", hex = "abcdef") {
  const { rows } = await pg.query<{ id: string }>(
    `insert into public.aircraft_registry_records
      (import_run_id, snapshot_date, registry_unique_id, n_number, mode_s_hex, manufacturer_name, registrant_kind, registrant_display_name, owner_visibility, source_row_hash)
     values ($1, $2::date, $3, 'N99ZZ', $4, 'SYNTHETIC TEST MFR', 'business', 'SYNTHETIC TEST ENTITY', $5, $6) returning id`,
    [run.id, run.date, `SYNTHETIC-${sequence++}`, hex, visibility, sha(String(sequence++))]);
  return rows[0]!.id;
}
async function match(id: string, status: string, method = "mode_s_hex_exact") {
  await pg.query(`insert into public.aircraft_registry_matches
    (aircraft_id, registry_record_id, match_status, match_method, matcher_version)
    values ($1, $2, $3, $4, 'synthetic-test')`, [aircraft.id, id, status, method]);
}

describe("registry SQL against actual PostgreSQL DDL", () => {
  it("distinguishes a missing source", async () => {
    expect(await lookupCurrentRegistry(db, aircraft, asOf)).toMatchObject({ status: "unmatched", unavailableReason: "no_published_snapshot", record: null });
  });
  it("excludes unpublished and future snapshots", async () => {
    await record(await snapshot("2026-11-08", "staging"));
    await record(await snapshot("2026-11-09"));
    expect(await lookupCurrentRegistry(db, aircraft, asOf)).toMatchObject({ unavailableReason: "no_published_snapshot", record: null });
  });
  it("resolves an exact published Mode-S record with no stored match or database writes", async () => {
    const id = await record(await snapshot());
    expect(await lookupCurrentRegistry(db, aircraft, asOf)).toMatchObject({ status: "confirmed", record: { record_id: id, match_method: "mode_s_hex_exact" } });
    expect((await pg.query<{ count: number }>("select count(*)::int as count from public.aircraft_registry_matches")).rows[0]!.count).toBe(0);
  });
  it("does not fall back to an older snapshot when the latest has no exact record", async () => {
    await record(await snapshot("2026-11-01"));
    await snapshot();
    expect(await lookupCurrentRegistry(db, aircraft, asOf)).toMatchObject({ unavailableReason: "no_exact_match", record: null });
  });
  it("uses latest owner visibility instead of resurrecting an older displayable owner", async () => {
    await record(await snapshot("2026-11-01"));
    const id = await record(await snapshot(), "withheld");
    expect(await lookupCurrentRegistry(db, aircraft, asOf)).toMatchObject({ status: "confirmed", record: { record_id: id, owner_visibility: "withheld" } });
  });
  it("keeps unresolved conflicts dominant instead of filtering them out", async () => {
    const run = await snapshot();
    await match(await record(run), "confirmed");
    await match(await record(run), "conflict");
    expect(await lookupCurrentRegistry(db, aircraft, asOf)).toMatchObject({ status: "conflict", record: null });
  });
  it("blocks ambiguous exact Mode-S matches even with no persisted matcher rows", async () => {
    const run = await snapshot();
    await record(run); await record(run);
    expect(await lookupCurrentRegistry(db, aircraft, asOf)).toMatchObject({ status: "conflict", record: null });
  });
  it.each([{ hex: "~abcdef" }, { hex: " ~ABCDEF " }, { hex: "abcdef", type: "tisb_trackfile" }])("withholds registry enrichment when retained raw evidence identifies a non-ICAO track: %j", async (raw) => {
    await record(await snapshot());
    await pg.query("insert into public.aircraft_positions (id, aircraft_id) values (1, $1)", [aircraft.id]);
    await pg.query("insert into airintel_private.raw_observations (id, position_id, payload) values (1, 1, $1::jsonb)", [JSON.stringify(raw)]);
    expect(await lookupCurrentRegistry(db, aircraft, asOf)).toMatchObject({ status: "conflict", record: null });
  });
  it("does not automatically enrich an identity after all retained raw provenance is gone", async () => {
    await record(await snapshot());
    await pg.exec("delete from airintel_private.raw_observations");
    expect(await lookupCurrentRegistry(db, aircraft, asOf)).toMatchObject({ status: "unmatched", unavailableReason: "identity_unverified", record: null });
  });
  it("finds a persisted registration-string conflict even when its Mode-S does not match", async () => {
    const id = await record(await snapshot(), "displayable_entity", "fedcba");
    await match(id, "confirmed", "registration_string_exact");
    expect(await lookupCurrentRegistry(db, aircraft, asOf)).toMatchObject({ status: "conflict", record: null });
  });
});
