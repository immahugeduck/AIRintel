import { describe, expect, it } from "vitest";
import type { Queryable } from "./db.js";
import { advanceEncounters, recordEncounters, type EncounterObservation, type EncounterState } from "./encounters.js";
import { countRadiusVisits } from "../src/domain/netted.js";
import { milesToNm } from "../src/domain/units.js";

// TEST FIXTURES ONLY. Synthetic coordinates/identifiers that exist solely inside this test file.
const userA = "860dc360-609f-4b7d-9e70-ec93fe6414d3";
const userB = "0f6d9a54-1111-4222-8333-444455556666";
const area = { latitude: 40, longitude: -86, radiusNm: milesToNm(7) };
const base = Date.parse("2026-10-17T12:00:00Z");
const at = (minute: number) => new Date(base + minute * 60_000).toISOString();
const inside = (minute: number, icao24 = "abc123", extra: Partial<EncounterObservation> = {}): EncounterObservation => ({ icao24, observedAt: at(minute), latitude: 40.01, longitude: -86, callsign: "TEST1", ...extra });
const outside = (minute: number, icao24 = "abc123"): EncounterObservation => ({ icao24, observedAt: at(minute), latitude: 40.5, longitude: -86 });
const empty: EncounterState = { lastObservedAt: null, lastInside: false, openEncounterId: null };

describe("advanceEncounters (netted-visits-v1, incremental)", () => {
  it("starts one encounter for the first inside observation and continues it while inside", () => {
    const result = advanceEncounters(empty, [inside(0), inside(1), inside(2)], area);
    expect(result.started).toHaveLength(1);
    expect(result.started[0]).toMatchObject({ observationCount: 3, callsign: "TEST1" });
    expect(result.next).toMatchObject({ lastInside: true, openIsLastStarted: true });
  });

  it("counts a new encounter after an exit, and after a reception gap over 10 minutes", () => {
    const result = advanceEncounters(empty, [inside(0), outside(1), inside(2), inside(20)], area);
    expect(result.started.map((segment) => segment.enteredAt)).toEqual([at(0), at(2), at(20)].map(Date.parse));
  });

  it("continues the open encounter from a previous batch instead of counting again", () => {
    const state: EncounterState = { lastObservedAt: Date.parse(at(1)), lastInside: true, openEncounterId: "open-id" };
    const result = advanceEncounters(state, [inside(2), inside(3)], area);
    expect(result.started).toHaveLength(0);
    expect(result.continued).toMatchObject({ observationCount: 2, lastSeenAt: Date.parse(at(3)) });
    expect(result.next).toMatchObject({ lastInside: true, openIsLastStarted: false, closesOpen: false });
  });

  it("closes the open encounter on exit and ignores observations at or before the watermark", () => {
    const state: EncounterState = { lastObservedAt: Date.parse(at(5)), lastInside: true, openEncounterId: "open-id" };
    expect(advanceEncounters(state, [inside(4), inside(5)], area).next).toBeNull();
    const result = advanceEncounters(state, [outside(6)], area);
    expect(result.started).toHaveLength(0);
    expect(result.next).toMatchObject({ lastInside: false, closesOpen: true });
  });

  it("matches countRadiusVisits no matter how the observations are split into batches", () => {
    const all = [inside(0), inside(3), outside(4), inside(5), inside(30), outside(31), outside(32), inside(33), inside(34)];
    const expected = countRadiusVisits(all, { ...area, gapMinutes: 10 })[0]!.visitCount;
    for (const split of [1, 2, 3, 5, 9]) {
      let state = empty;
      let count = 0;
      for (let offset = 0; offset < all.length; offset += split) {
        const result = advanceEncounters(state, all.slice(offset, offset + split), area);
        count += result.started.length;
        if (result.next) state = { lastObservedAt: result.next.lastObservedAt, lastInside: result.next.lastInside, openEncounterId: result.next.openIsLastStarted ? "new" : result.next.closesOpen ? null : state.openEncounterId };
      }
      expect(count).toBe(expected);
    }
  });
});

/** Tiny in-memory model of the two 0006 tables, driven by the exact statements encounters.ts issues. */
function memoryDb() {
  type Tally = { user_id: string; icao24: string; encounter_count: number; first_encountered_at: Date | null; last_seen_in_radius_at: Date | null; last_observed_at: Date | null; last_inside: boolean; open_encounter_id: string | null; last_callsign: string | null };
  const tallies = new Map<string, Tally>();
  const encounters = new Map<string, { id: string; user_id: string; icao24: string; observation_count: number; source: string; entered_at: string }>();
  let seq = 0;
  const key = (user: unknown, icao: unknown) => `${String(user)}:${String(icao)}`;
  const db: Queryable = {
    query: async (text: string, p: readonly unknown[] = []) => {
      const rows = (value: unknown[]) => ({ rows: value }) as never;
      if (text.includes("select icao24, last_observed_at")) return rows([...tallies.values()].filter((t) => t.user_id === p[0] && (p[1] as string[]).includes(t.icao24)));
      if (text.includes("insert into airintel_private.user_aircraft_tallies")) {
        if (tallies.has(key(p[0], p[1]))) return rows([]);
        tallies.set(key(p[0], p[1]), { user_id: String(p[0]), icao24: String(p[1]), encounter_count: 0, first_encountered_at: null, last_seen_in_radius_at: null, last_observed_at: new Date(String(p[2])), last_inside: p[3] === true, open_encounter_id: null, last_callsign: null });
        return rows([{ icao24: p[1] }]);
      }
      if (text.includes("set last_observed_at = $3")) {
        const t = tallies.get(key(p[0], p[1]));
        const expected = p[4] === null ? null : new Date(String(p[4])).getTime();
        if (!t || (t.last_observed_at?.getTime() ?? null) !== expected) return rows([]);
        t.last_observed_at = new Date(String(p[2])); t.last_inside = p[3] === true;
        return rows([{ icao24: p[1] }]);
      }
      if (text.includes("insert into airintel_private.encounters")) {
        const id = `enc-${++seq}`;
        encounters.set(id, { id, user_id: String(p[0]), icao24: String(p[1]), observation_count: Number(p[7]), source: String(p[11]), entered_at: String(p[4]) });
        return rows([{ id }]);
      }
      if (text.includes("update airintel_private.encounters")) { const e = encounters.get(String(p[0])); if (e) e.observation_count += Number(p[3]); return rows([]); }
      if (text.includes("set encounter_count = encounter_count + $3")) {
        const t = tallies.get(key(p[0], p[1]))!;
        t.encounter_count += Number(p[2]);
        t.first_encountered_at ??= p[3] ? new Date(String(p[3])) : null;
        if (p[5]) t.last_seen_in_radius_at = new Date(String(p[5]));
        t.last_callsign = (p[7] as string | null) ?? t.last_callsign;
        t.open_encounter_id = (p[9] as string | null) ?? null;
        return rows([]);
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  };
  return { db, tallies, encounters };
}

describe("recordEncounters (per-account log + lifetime counter)", () => {
  it("logs a new encounter and increments the lifetime counter on each re-encounter, continuing open ones", async () => {
    const { db, tallies, encounters } = memoryDb();
    await recordEncounters(db, userA, area, [inside(0), inside(1)], "live");
    await recordEncounters(db, userA, area, [inside(2)], "sweep"); // same encounter, later batch
    expect(tallies.get(`${userA}:abc123`)?.encounter_count).toBe(1);
    expect([...encounters.values()]).toHaveLength(1);
    expect([...encounters.values()][0]!.observation_count).toBe(3);

    await recordEncounters(db, userA, area, [outside(3)], "sweep");
    const back = await recordEncounters(db, userA, area, [inside(4)], "sweep");
    expect(back.started).toBe(1);
    expect(tallies.get(`${userA}:abc123`)?.encounter_count).toBe(2);
    expect([...encounters.values()].map((e) => e.source)).toEqual(["live", "sweep"]);
  });

  it("is idempotent: replaying the same observations never double counts", async () => {
    const { db, tallies } = memoryDb();
    const batch = [inside(0), outside(1), inside(2)];
    await recordEncounters(db, userA, area, batch, "live");
    await recordEncounters(db, userA, area, batch, "sweep");
    expect(tallies.get(`${userA}:abc123`)?.encounter_count).toBe(2);
  });

  it("keeps separate logs per account and only measures against that account's own radius", async () => {
    const { db, tallies } = memoryDb();
    const far = { latitude: 45, longitude: -90, radiusNm: milesToNm(7) };
    await recordEncounters(db, userA, area, [inside(0)], "sweep");
    await recordEncounters(db, userB, far, [inside(0)], "sweep");
    expect(tallies.get(`${userA}:abc123`)?.encounter_count).toBe(1);
    expect(tallies.has(`${userB}:abc123`)).toBe(false);
  });

  it("creates no rows for aircraft that never entered the radius and skips invalid ids", async () => {
    const { db, tallies, encounters } = memoryDb();
    const result = await recordEncounters(db, userA, area, [outside(0), { ...inside(1), icao24: "zzz" }], "live");
    expect(result).toEqual({ aircraft: 0, started: 0, continued: 0, skipped: 0 });
    expect(tallies.size).toBe(0);
    expect(encounters.size).toBe(0);
  });

  it("never throws: a database failure is reported as skipped", async () => {
    const failing: Queryable = { query: async () => { throw Object.assign(new Error("boom"), { code: "57014" }); } };
    await expect(recordEncounters(failing, userA, area, [inside(0)], "live")).resolves.toMatchObject({ skipped: 1 });
  });
});
