import { describe, expect, it } from "vitest";
import { assessPattern } from "../src/domain/patterns.js";
import { aggregateSightings, controlTooClose, loadControlComparison, loadDueControlAreas } from "./control-areas.js";
import type { Queryable } from "./db.js";
import { planSweep, type SweepMember } from "./net-sweep.js";

const control = { latitude: 40, longitude: -86, radiusMi: 7 };
const obs = (icao24: string, at: string, latitude = 40.01, longitude = -86) => ({ icao24, observedAt: at, latitude, longitude });

describe("aggregateSightings", () => {
  it("counts observations inside the control circle per aircraft and UTC day", () => {
    const rows = aggregateSightings(control, [
      obs("abc123", "2026-11-09T10:00:00Z"), obs("abc123", "2026-11-09T10:05:00Z", 40.02), obs("abc123", "2026-11-10T01:00:00Z"),
      obs("def456", "2026-11-09T10:00:00Z", 41), // outside (~60 NM)
      obs("nothex", "2026-11-09T10:00:00Z"),
    ]).sort((a, b) => a.day.localeCompare(b.day));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ icao24: "abc123", day: "2026-11-09", count: 2, firstSeenAt: "2026-11-09T10:00:00.000Z", lastSeenAt: "2026-11-09T10:05:00.000Z" });
    expect(rows[1]).toMatchObject({ icao24: "abc123", day: "2026-11-10", count: 1 });
  });
});

describe("controlTooClose", () => {
  it("rejects a control center within 10 mi of the watch center", () => {
    expect(controlTooClose({ latitude: 40.05, longitude: -86 }, { latitude: 40, longitude: -86 })).toBeCloseTo(3.45, 1);
    expect(controlTooClose({ latitude: 40.3, longitude: -86 }, { latitude: 40, longitude: -86 })).toBeNull();
    expect(controlTooClose({ latitude: 40, longitude: -86 }, null)).toBeNull();
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
  const base = { icao24: "abc123", callsign: "N123AB", registration: "N123AB", aircraftTypeCode: "C172", visitCount: 4, visits: [visit(1), visit(2), visit(3), visit(4)], centers: [] };
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
