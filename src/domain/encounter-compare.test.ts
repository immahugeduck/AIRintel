import { describe, expect, it } from "vitest";
import { passFlags, straightPassMinutes, timeInside, typicalPass } from "./encounter-compare";
import { bearingDeg, compassPoint } from "./geometry";
import type { NettedVisit } from "./netted";

// SYNTHETIC TEST VECTORS ONLY.
const visit = (minute: number, closestMi: number, altitudeFt: number | null, speedKt: number | null, insideMin = 1): NettedVisit => {
  const entered = Date.UTC(2026, 10, 18, 12, minute);
  return {
    enteredAt: new Date(entered).toISOString(),
    lastSeenInRadiusAt: new Date(entered + insideMin * 60_000).toISOString(),
    closestMi,
    observationCount: 2,
    closest: { at: new Date(entered).toISOString(), latitude: 40, longitude: -86, altitudeFt, altitudeSource: altitudeFt === null ? null : "barometric", groundSpeedKt: speedKt, trackDeg: 90, verticalRateFpm: 0, onGround: false, bearingFromCenterDeg: 45, basis: "at_write" },
  };
};

describe("typical pass and pass flags", () => {
  const usual = [visit(0, 6, 3000, 100), visit(10, 5.8, 3200, 105), visit(20, 6.2, 2900, 95), visit(30, 6, 3100, 100)];

  it("uses medians of this aircraft's own entries", () => {
    expect(typicalPass(usual)).toMatchObject({ entries: 4, closestMi: 6, altitudeFt: 3050 });
  });

  it("flags a pass that was much closer, lower and longer than usual", () => {
    const odd = visit(40, 2, 1500, 60, 12);
    expect(passFlags(odd, typicalPass([...usual, odd]))).toEqual(["closer", "lower", "longer"]);
  });

  it("does not flag ordinary passes or compare with too few entries", () => {
    expect(passFlags(usual[0]!, typicalPass(usual))).toEqual([]);
    const two = [visit(0, 6, 3000, 100), visit(10, 1, 500, 50)];
    expect(passFlags(two[1]!, typicalPass(two))).toEqual([]);
  });

  it("ignores entries without closest-point details", () => {
    expect(typicalPass([{ ...usual[0]!, closest: null }]).entries).toBe(0);
  });
});

describe("bearing helpers", () => {
  it("gives compass directions from the center", () => {
    expect(compassPoint(bearingDeg(40, -86, 40.1, -86))).toBe("N");
    expect(compassPoint(bearingDeg(40, -86, 40.07, -85.91))).toBe("NE");
    expect(compassPoint(bearingDeg(40, -86, 39.9, -86))).toBe("S");
    expect(compassPoint(359)).toBe("N");
  });
});

describe("timing", () => {
  const base = Date.UTC(2026, 11, 1, 12, 0);
  const iso = (minute: number) => new Date(base + minute * 60_000).toISOString();
  const timed = (enteredAfter: number | null, entered: number, last: number, exitedBefore: number | null, closestMi: number, speedKt: number): NettedVisit => ({
    enteredAt: iso(entered), lastSeenInRadiusAt: iso(last), closestMi, observationCount: 3,
    enteredAfter: enteredAfter === null ? null : iso(enteredAfter), exitedBefore: exitedBefore === null ? null : iso(exitedBefore),
    closest: { at: iso(entered), latitude: 40, longitude: -86, altitudeFt: 2000, altitudeSource: "barometric", groundSpeedKt: speedKt, trackDeg: 0, verticalRateFpm: 0, onGround: false, bearingFromCenterDeg: 0, basis: "at_write" },
  });

  it("gives time inside as a range between the inside sightings and the outside sightings around them", () => {
    expect(timeInside(timed(0, 1, 5, 6, 3, 100))).toEqual({ atLeast: 4, atMost: 6 });
    expect(timeInside(timed(null, 1, 5, 6, 3, 100))).toEqual({ atLeast: 4, atMost: null });
  });

  it("computes the straight-pass time along the chord at the closest distance", () => {
    // 7 mi radius, passed through the center at 104.3 kt (120 mph): 14 mi takes 7 min.
    expect(straightPassMinutes(timed(0, 1, 2, 3, 0, 104.276), 7)).toBeCloseTo(7, 1);
    expect(straightPassMinutes(timed(0, 1, 2, 3, 0, 10), 7)).toBeNull();
  });

  it("flags a pass that stayed far longer than a straight pass at its speed, even with no history", () => {
    const loiter = timed(0, 1, 31, 32, 1, 90); // straight pass 8.0 min, stayed 30+ min
    expect(passFlags(loiter, typicalPass([loiter]), 7)).toEqual(["lingered"]);
    const transit = timed(0, 1, 7, 8, 1, 90);
    expect(passFlags(transit, typicalPass([transit]), 7)).toEqual([]);
  });
});
