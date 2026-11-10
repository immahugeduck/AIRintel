import { describe, expect, it } from "vitest";
import { assessPattern, countSeparateCenters, cumulativeTurnDeg, headingDelta, routineExplanation, type PatternInput, type PatternPosition, type PatternVisit } from "./patterns";

// TEST FIXTURES ONLY: hand-written synthetic geometry used to exercise the pattern rules.
// They are not provider data and are never shipped in the application bundle.
const CENTER = { latitude: 40, longitude: -86 };
const t = (day: number, minute: number) => new Date(Date.UTC(2026, 9, day, 15, 0) + minute * 60_000).toISOString();
const pos = (day: number, minute: number, extra: Partial<PatternPosition> = {}): PatternPosition => ({
  observedAt: t(day, minute), latitude: CENTER.latitude + 0.005, longitude: CENTER.longitude, altitudeFt: 2_500, groundSpeedKt: 95, trackDeg: null, verticalRateFpm: 0, ...extra,
});
/** A full orbit: tracks stepping 45° every minute for `minutes` minutes. */
const orbit = (day: number, minutes: number): PatternVisit => ({
  enteredAt: t(day, 0), lastSeenInRadiusAt: t(day, minutes), center: CENTER,
  positions: Array.from({ length: minutes + 1 }, (_, i) => pos(day, i, { trackDeg: (i * 45) % 360 })),
});
const straight = (day: number, extra: Partial<PatternPosition> = {}): PatternVisit => ({
  enteredAt: t(day, 0), lastSeenInRadiusAt: t(day, 3), center: CENTER,
  positions: [0, 1, 2, 3].map((i) => pos(day, i, { trackDeg: 90, ...extra })),
});
const base = (overrides: Partial<PatternInput>): PatternInput => ({ icao24: "abc123", callsign: "N123AB", registration: "N123AB", aircraftTypeCode: "C182", visitCount: 1, visits: [], centers: [], ...overrides });

describe("heading math", () => {
  it("wraps across north", () => {
    expect(headingDelta(350, 10)).toBe(20);
    expect(headingDelta(10, 350)).toBe(-20);
  });
  it("counts a consistent orbit and cancels S-turns", () => {
    expect(cumulativeTurnDeg(orbit(1, 10).positions).turnDeg).toBe(450);
    const weave = [90, 120, 90, 60, 90, 120, 90].map((track, i) => pos(1, i, { trackDeg: track }));
    expect(cumulativeTurnDeg(weave).turnDeg).toBe(0);
  });
});

describe("routine explanations (pass 1)", () => {
  it("recognizes scheduled airlines, charter operators and local training fleets", () => {
    expect(routineExplanation({ callsign: "SWA461", registration: null })?.code).toBe("scheduled_operator");
    expect(routineExplanation({ callsign: "EJA123", registration: null })?.code).toBe("charter_operator");
    expect(routineExplanation({ callsign: "LTA661", registration: "N661L" })?.code).toBe("training_fleet");
    expect(routineExplanation({ callsign: "N69VU", registration: "N69VU" })?.code).toBe("training_fleet");
    expect(routineExplanation({ callsign: "N8274N", registration: "N8274N" })).toBeNull();
  });

  it("keeps a circling training aircraft routine (turns around a point are a training maneuver)", () => {
    const result = assessPattern(base({ callsign: "LTA661", registration: "N661L", visitCount: 36, visits: [orbit(1, 20), orbit(2, 20), orbit(3, 20)] }));
    expect(result.tier).toBe("routine");
    expect(result.explainedBy).toMatch(/LIFT/);
    expect(result.score).toBeLessThanOrEqual(0);
  });

  it("treats cruise-altitude transit as routine", () => {
    const result = assessPattern(base({ callsign: null, visits: [straight(1, { altitudeFt: 35_000, groundSpeedKt: 450 })] }));
    expect(result.reasons.some((r) => r.code === "cruise_transit")).toBe(true);
    expect(result.tier).not.toBe("priority");
  });
});

describe("behavior and location passes (2 and 3)", () => {
  it("raises an unexplained aircraft that repeatedly orbits over the watch center", () => {
    const result = assessPattern(base({ visitCount: 6, visits: [orbit(1, 20), orbit(3, 20), orbit(5, 20)] }));
    expect(result.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["circling", "centered_orbit", "loiter", "low_slow", "recurrence"]));
    expect(result.tier).toBe("priority");
  });

  it("leaves a single straight low pass at low priority", () => {
    const result = assessPattern(base({ visits: [straight(1)] }));
    expect(result.tier).toBe("low");
  });

  it("flags an airframe logged at separate watch locations, even for a routine operator", () => {
    const centers = [{ latitude: 40, longitude: -86, encounters: 5 }, { latitude: 40, longitude: -86.5, encounters: 3 }];
    expect(countSeparateCenters(centers)).toBe(2);
    const plain = assessPattern(base({ visits: [straight(1)], centers }));
    expect(plain.reasons.some((r) => r.code === "multi_location")).toBe(true);
    const training = assessPattern(base({ callsign: "LTA661", visits: [straight(1)], centers }));
    expect(training.tier).not.toBe("routine");
  });

  it("does not count nearby or overlapping watch circles as separate locations", () => {
    expect(countSeparateCenters([{ latitude: 40, longitude: -86, encounters: 1 }, { latitude: 40.02, longitude: -86.02, encounters: 1 }])).toBe(1);
    // ~9.4 NM apart: two 6.1 NM circles overlap, so one straight pass can register at both.
    expect(countSeparateCenters([{ latitude: 39.67, longitude: -86.58, encounters: 1 }, { latitude: 39.64, longitude: -86.78, encounters: 1 }])).toBe(1);
  });

  it("never escalates a cruise-altitude airliner on location correlation", () => {
    const centers = [{ latitude: 40, longitude: -86, encounters: 5 }, { latitude: 40, longitude: -86.5, encounters: 3 }];
    const result = assessPattern(base({ callsign: "SWA2198", visits: [straight(1, { altitudeFt: 38_000, groundSpeedKt: 450 })], centers }));
    expect(result.tier).toBe("routine");
    expect(result.reasons.some((r) => r.code === "multi_location")).toBe(false);
  });

  it("reports sparse coverage instead of guessing when tracks are missing", () => {
    const result = assessPattern(base({ visits: [{ enteredAt: t(1, 0), lastSeenInRadiusAt: t(1, 0), center: CENTER, positions: [] }] }));
    expect(result.coverage).toBe("sparse");
    expect(result.reasons.find((r) => r.code === "sparse_coverage")?.evidence).toBe("Unknown");
  });
});
