import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM operator script without type declarations
import { importSnapshot, registrantFor } from "../scripts/lib/faa.mjs";
import type { Queryable } from "./db.js";
import { lookupCurrentRegistry, lookupRegistryIdentities, lookupRegistryRegistrations } from "./registry.js";

// SYNTHETIC TEST VECTORS ONLY (invented N-numbers, names and addresses), in an ephemeral WASM PostgreSQL instance.
const HEADER = "N-NUMBER,SERIAL NUMBER,MFR MDL CODE,ENG MFR MDL,YEAR MFR,TYPE REGISTRANT,NAME,STREET,STREET2,CITY,STATE,ZIP CODE,REGION,COUNTY,COUNTRY,LAST ACTION DATE,CERT ISSUE DATE,CERTIFICATION,TYPE AIRCRAFT,TYPE ENGINE,STATUS CODE,MODE S CODE,FRACT OWNER,AIR WORTH DATE,OTHER NAMES(1),OTHER NAMES(2),OTHER NAMES(3),OTHER NAMES(4),OTHER NAMES(5),EXPIRATION DATE,UNIQUE ID,KIT MFR, KIT MODEL,MODE S CODE HEX,";
const row = (n: string, kind: string, name: string, hex: string, id: string) =>
  `${n},SER${id},2072738,41514,2001,${kind},${name},123 SYNTHETIC ST,,TESTVILLE,IN,46000,3,097,US,20240101,20200101,1N,4,1,V,50000000,,20000101,,,,,,20300101,${id},,,${hex},`;
const MASTER = [
  HEADER,
  row("99ZZ", "3", "SYNTHETIC AVIATION LLC", "ABCDEF", "900001"), // business -> displayable
  row("98YY", "1", "DOE JANE Q", "ABCDE0", "900002"), // individual -> redacted
  row("97XX", "5", "SYNTHETIC COUNTY SHERIFF", "", "900003"), // no Mode S
  row("IOI", "3", "BAD N NUMBER LLC", "ABCDE1", "900004"), // invalid N-number -> quarantined
  // Filler so the one bad row stays under the 5% rejection limit.
  ...Array.from({ length: 30 }, (_, i) => row(`5${String(i).padStart(2, "0")}A`, "3", `FILLER ${i} INC`, "", `91${String(i).padStart(4, "0")}`)),
].join("\n");
const ACFTREF = "CODE,MFR,MODEL,TYPE-ACFT\n2072738,CESSNA,172S,4\n";

let pg: PGlite;
let dir: string;
const db: Queryable & { query: Queryable["query"] } = { query: <Row extends QueryResultRow>(text: string, params?: readonly unknown[]) => pg.query<Row>(text, [...(params ?? [])]) };
const aircraft = { id: "11111111-1111-4111-8111-111111111111", icao24: "abcdef", registration: null };

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`create schema airintel_private;
    create table public.aircraft (id uuid primary key, icao24 text, registration text);
    create table public.aircraft_positions (id bigint primary key, aircraft_id uuid references public.aircraft(id));
    create table airintel_private.raw_observations (id bigint primary key, position_id bigint unique references public.aircraft_positions(id), payload jsonb not null);`);
  await pg.exec(readFileSync(new URL("../db/migrations/0003_phase_three_aircraft_profiles.sql", import.meta.url), "utf8"));
  await pg.query("insert into public.aircraft (id, icao24, registration) values ($1, $2, null)", [aircraft.id, aircraft.icao24]);
  await pg.query("insert into public.aircraft_positions (id, aircraft_id) values (10, $1)", [aircraft.id]);
  await pg.query("insert into airintel_private.raw_observations (id, position_id, payload) values (10, 10, $1::jsonb)", [JSON.stringify({ hex: "abcdef", type: "adsb_icao" })]);
  dir = mkdtempSync(join(tmpdir(), "faa-import-test-"));
  writeFileSync(join(dir, "MASTER.txt"), MASTER);
  writeFileSync(join(dir, "ACFTREF.txt"), ACFTREF);
}, 30_000);
beforeEach(async () => {
  await pg.exec("truncate public.aircraft_registry_matches, public.aircraft_registry_records, airintel_private.faa_registry_raw, airintel_private.faa_import_runs cascade");
});
afterAll(async () => { await pg?.close(); rmSync(dir, { recursive: true, force: true }); });

const run = (publish: boolean) => importSnapshot(db, { inputPath: join(dir, "MASTER.txt"), acftrefPath: join(dir, "ACFTREF.txt"), snapshotDate: "2026-11-01", publish });

describe("FAA import (synthetic MASTER)", () => {
  it("stages, publishes, and the existing registry lookup then resolves the owner by exact Mode S", async () => {
    const summary = await run(true);
    expect(summary).toMatchObject({ status: "published", rows: { received: 34, accepted: 33, rejected: 1 }, errors: { invalid_n_number: 1 } });
    const result = await lookupCurrentRegistry(db, aircraft, new Date("2026-11-08T00:00:00Z"));
    expect(result.status).toBe("confirmed");
    expect(result.record).toMatchObject({ n_number: "N99ZZ", registrant_display_name: "SYNTHETIC AVIATION LLC", registrant_kind: "business", owner_visibility: "displayable_entity", manufacturer_name: "CESSNA", model_name: "172S" });
  });

  it("never stores a natural person's name, and never stores street addresses or ZIP codes", async () => {
    await run(true);
    const { rows } = await pg.query<{ registrant_display_name: string | null; owner_visibility: string }>("select registrant_display_name, owner_visibility from public.aircraft_registry_records where n_number = 'N98YY'");
    expect(rows[0]).toEqual({ registrant_display_name: null, owner_visibility: "individual_redacted" });
    const raw = await pg.query<{ raw: string }>("select raw_row::text as raw from airintel_private.faa_registry_raw");
    expect(raw.rows.length).toBe(34);
    expect(raw.rows.some((r) => /SYNTHETIC ST|46000|"STREET"|"ZIP CODE"/.test(r.raw))).toBe(false);
  });

  it("stages without publishing, then the same file is only promoted on --publish (recognized by SHA-256)", async () => {
    expect((await run(false)).status).toBe("validated");
    expect((await lookupCurrentRegistry(db, aircraft, new Date("2026-11-08T00:00:00Z"))).unavailableReason).toBe("no_published_snapshot");
    const again = await run(true);
    expect(again).toMatchObject({ status: "published", alreadyImported: true });
    const count = await pg.query<{ n: number }>("select count(*)::int as n from public.aircraft_registry_records");
    expect(count.rows[0]!.n).toBe(33);
  });

  it("rejects future snapshot dates and non-FAA source URLs", async () => {
    await expect(importSnapshot(db, { inputPath: join(dir, "MASTER.txt"), snapshotDate: "2999-01-01" })).rejects.toThrow(/future/);
    await expect(importSnapshot(db, { inputPath: join(dir, "MASTER.txt"), snapshotDate: "2026-11-01", sourceUrl: "https://example.com/x" })).rejects.toThrow(/faa.gov/);
  });
});

describe("lookupRegistryRegistrations (netted list fallback)", () => {
  it("returns the N-number for an exact Mode-S match in the published snapshot only", async () => {
    await run(false);
    expect(await lookupRegistryRegistrations(db, ["abcdef"])).toEqual(new Map());
    await run(true);
    expect(await lookupRegistryRegistrations(db, ["abcdef", "abcde0", "123456"])).toEqual(new Map([["abcdef", "N99ZZ"], ["abcde0", "N98YY"]]));
  });

  it("fails closed on a rejected persisted match and never throws", async () => {
    await run(true);
    await pg.query(
      `insert into public.aircraft_registry_matches (aircraft_id, registry_record_id, match_status, match_method, matcher_version, manual_review_status)
       select $1, id, 'confirmed', 'manual', 'test', 'rejected' from public.aircraft_registry_records where n_number = 'N99ZZ'`, [aircraft.id]);
    expect((await lookupRegistryRegistrations(db, ["abcdef"])).has("abcdef")).toBe(false);
    const broken: Queryable = { query: async () => { throw new Error("boom"); } };
    expect(await lookupRegistryRegistrations(broken, ["abcdef"])).toEqual(new Map());
  });
});

describe("lookupRegistryIdentities (pattern identity signals + type fallback)", () => {
  it("returns owner kind, displayable owner name, FAA model and aircraft type for exact Mode-S matches", async () => {
    await run(true);
    const identities = await lookupRegistryIdentities(db, ["abcdef", "abcde0", "zzzzzz"]);
    expect(identities.get("abcdef")).toEqual({ nNumber: "N99ZZ", registrantKind: "business", registrantName: "SYNTHETIC AVIATION LLC", model: "CESSNA 172S", faaAircraftType: "4" });
    // Individuals stay redacted: kind only, never a name.
    expect(identities.get("abcde0")).toMatchObject({ nNumber: "N98YY", registrantKind: "individual", registrantName: null });
    expect(identities.has("zzzzzz")).toBe(false);
  });

  it("returns nothing before a snapshot is published, and never throws", async () => {
    await run(false);
    expect(await lookupRegistryIdentities(db, ["abcdef"])).toEqual(new Map());
    const broken: Queryable = { query: async () => { throw new Error("boom"); } };
    expect(await lookupRegistryIdentities(broken, ["abcdef"])).toEqual(new Map());
  });
});

describe("registrantFor", () => {
  it("only displays business and government registrants", () => {
    expect(registrantFor("1", "DOE JANE")).toEqual({ kind: "individual", visibility: "individual_redacted", displayName: null });
    expect(registrantFor("4", "DOE JANE & JOHN")).toEqual({ kind: "other", visibility: "individual_redacted", displayName: null });
    expect(registrantFor("7", "ACME  LLC")).toEqual({ kind: "business", visibility: "displayable_entity", displayName: "ACME LLC" });
    expect(registrantFor("5", "")).toEqual({ kind: "government", visibility: "unavailable", displayName: null });
  });
});
