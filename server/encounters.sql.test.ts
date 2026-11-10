import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable } from "./db.js";
import { recordEncounters } from "./encounters.js";

// SYNTHETIC TEST VECTORS ONLY, in an ephemeral WASM PostgreSQL instance with the real 0006 + 0007 DDL.
let pg: PGlite;
const db: Queryable = { query: <Row extends QueryResultRow>(text: string, params?: readonly unknown[]) => pg.query<Row>(text, [...(params ?? [])]) as never };
const user = "22222222-2222-4222-8222-222222222222";
const area = { latitude: 40, longitude: -86, radiusNm: 6 };
const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 15, minute)).toISOString();
const inside = (icao24: string, minute: number) => ({ icao24, observedAt: at(minute), latitude: 40.01, longitude: -86, callsign: "TEST1", registration: null });

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec("create schema airintel_private;");
  await pg.exec(readFileSync(new URL("../db/migrations/0006_account_encounters.sql", import.meta.url), "utf8"));
  await pg.exec("create table airintel_private.net_watch_areas (user_id uuid primary key);");
  await pg.exec(readFileSync(new URL("../db/migrations/0007_follow_me_and_control_circles.sql", import.meta.url), "utf8"));
});
afterAll(async () => { await pg.close(); });

describe("encounter center_mode against real DDL", () => {
  it("writes follow / fixed on encounters started through the sweep and live paths", async () => {
    await recordEncounters(db, user, { ...area, centerMode: "follow" }, [inside("aaa001", 0), inside("aaa001", 1)], "sweep");
    await recordEncounters(db, user, { ...area, centerMode: "fixed" }, [inside("aaa002", 0)], "live");
    const { rows } = await pg.query<{ icao24: string; center_mode: string | null }>("select icao24, center_mode from airintel_private.encounters order by icao24");
    expect(rows).toEqual([{ icao24: "aaa001", center_mode: "follow" }, { icao24: "aaa002", center_mode: "fixed" }]);
  });
});
