import { describe, expect, it } from "vitest";
import { assessPattern } from "../src/domain/patterns.js";
import { ControlTooCloseError, aggregateSightings, controlTooClose, loadControlComparison, loadDueControlAreas, upsertControlArea } from "./control-areas.js";
import type { Queryable } from "./db.js";
import { planSweep, type SweepMember } from "./net-sweep.js";

const control = { latitude: 40, longitude: -86, radiusMi: 7 };
const obs = (icao24: string, at: string, latitude = 40.01, longitude = -86) => ({ icao24, observedAt: at, latitude, longitude });

describe("aggregateSightings", () => {
  it("counts observations inside the control circle per aircraft and local (America/Indianapolis) day", () => {
    const rows = aggregateSightings(control, [
      // 01:00 UTC on Nov 10 is 8 PM EST on Nov 9: same local day as the morning sightings.
      obs("abc123", "2026-11-09T10:00:00Z"), obs("abc123", "2026-11-09T10:05:00Z", 40.02), obs("abc123", "2026-11-10T01:00:00Z"),
      obs("abc123", "2026-11-10T15:00:00Z"),
      obs("def456", "2026-11-09T10:00:00Z", 41), // outside (~60 NM)
      obs("nothex", "2026-11-09T10:00:00Z"),
    ]).sort((a, b) => a.day.localeCompare(b.day));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ icao24: "abc123", day: "2026-11-09", count: 3, firstSeenAt: "2026-11-09T10:00:00.000Z", lastSeenAt: "2026-11-10T01:00:00.000Z" });
    expect(rows[1]).toMatchObject({ icao24: "abc123", day: "2026-11-10", count: 1 });
  });
});

describe("controlTooClose", () => {
  const watch = { latitude: 40, longitude: -86, radiusMi: 7 };
  it("rejects a control circle that overlaps the watch circle", () => {
    expect(controlTooClose({ latitude: 40.05, longitude: -86, radiusMi: 2 }, [watch])?.distanceMi).toBeCloseTo(3.45, 1);
    expect(controlTooClose({ latitude: 40, longitude: -86, radiusMi: 2 }, [])).toBeNull();
  });
  it("rejects a control circle whose radius overlaps the watch circle even when the centers are 10+ mi apart", () => {
    // ~20.7 mi apart: a 7 mi watch circle and a 15 mi control circle overlap.
    const result = controlTooClose({ latitude: 40.3, longitude: -86, radiusMi: 15 }, [watch]);
    expect(result?.requiredMi).toBe(22.5);
    expect(controlTooClose({ latitude: 40.3, longitude: -86, radiusMi: 7 }, [watch])).toBeNull();
  });
  it("allows a small control close by when the circles do not overlap (no more 10 mi floor)", () => {
    // ~9.7 mi from a 7 mi watch circle: a 2 mi control needs 7 + 2 + 0.5 = 9.5 mi.
    expect(controlTooClose({ latitude: 40.14, longitude: -86, radiusMi: 2 }, [watch])).toBeNull();
    // Any control center closer than the 3 mi floor is still refused.
    expect(controlTooClose({ latitude: 40.02, longitude: -86, radiusMi: 1 }, [{ latitude: 40, longitude: -86, radiusMi: 1 }])?.requiredMi).toBe(3);
  });
  it("also checks places you were netted at with follow me (recent encounter centers)", () => {
    const visited = { latitude: 41, longitude: -86, radiusMi: 7 };
    expect(controlTooClose({ latitude: 41.02, longitude: -86, radiusMi: 7 }, [watch, visited])?.distanceMi).toBeCloseTo(1.4, 1);
  });
});

describe("upsertControlArea", () => {
  it("rejects a control circle at a place recently used as a follow-me watch center", async () => {
    const queries: string[] = [];
    const db: Queryable = {
      query: async (text: string) => {
        queries.push(text);
        if (/from airintel_private\.net_watch_areas/.test(text)) return { rows: [{ latitude: 40, longitude: -86, radius_mi: 7 }] } as never;
        if (/from airintel_private\.encounters/.test(text)) return { rows: [{ latitude: 41, longitude: -86, radius_nm: 6.08 }] } as never;
        throw new Error("unexpected write");
      },
    };
    await expect(upsertControlArea(db, "u1", { slot: 1, label: "", latitude: 41.02, longitude: -86, radiusMi: 7, enabled: true })).rejects.toBeInstanceOf(ControlTooCloseError);
    expect(queries.some((q) => /insert into/.test(q))).toBe(false);
  });
});

describe("migration 0007 not applied", () => {
  const missing: Queryable = { query: async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); } };
  it("the sweep sees no control circles instead of failing", async () => {
    await expect(loadDueControlAreas(missing, { minIntervalSeconds: 60, limit: 10 })).resolves.toEqual([]);
  });
  it("pattern scoring gets no comparison instead of failing", async () => {
    await expect(loadControlComparison(missing, "u", ["abc123"])).resolves.toEqual(new Map());
  });
});

describe("planSweep with control circles", () => {
  it("lets a control circle ride on an overlapping watch-area query and plans a separate query otherwise", () => {
    const members: SweepMember[] = [
      { userId: "u1", latitude: 40, longitude: -86, radiusMi: 10 },
      { kind: "control", controlId: "c1", userId: "u1", latitude: 40.01, longitude: -86, radiusMi: 3 },
      { kind: "control", controlId: "c2", userId: "u1", latitude: 41, longitude: -86, radiusMi: 7 },
    ];
    const plan = planSweep(members, 1.25, 5);
    expect(plan.queries).toHaveLength(2);
    expect(plan.covered).toBe(1);
  });
});

describe("pattern pass 4: control comparison", () => {
  const visit = (day: number) => ({ enteredAt: `2026-11-0${day}T12:00:00Z`, lastSeenInRadiusAt: `2026-11-0${day}T12:05:00Z`, center: null, positions: [] });
  const base = { icao24: "abc123", callsign: "N123AB", registration: "N123AB", aircraftTypeCode: "C172", visitCount: 4, visits: [visit(1), visit(2), visit(3), visit(4)], sightings: [] };
  it("marks aircraft that are just as common at the controls as ordinary local traffic", () => {
    const result = assessPattern({ ...base, control: { activeCircles: 1, daysAtControls: 3 } });
    expect(result.reasons.find((r) => r.code === "control_common")?.weight).toBe(-2);
  });
  it("raises aircraft seen near you on several days but never at the controls", () => {
    const result = assessPattern({ ...base, control: { activeCircles: 2, daysAtControls: 0 } });
    expect(result.reasons.find((r) => r.code === "control_absent")?.weight).toBe(1);
  });
  it("says nothing when no control circle has been swept", () => {
    const result = assessPattern(base);
    expect(result.reasons.some((r) => r.code.startsWith("control_"))).toBe(false);
  });
});
