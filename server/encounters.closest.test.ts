import { describe, expect, it } from "vitest";
import { advanceEncounters, type EncounterObservation, type EncounterState } from "./encounters.js";
import { milesToNm } from "../src/domain/units.js";

// SYNTHETIC TEST VECTORS ONLY: made-up coordinates and flight states that exist solely inside this file.
const area = { latitude: 40, longitude: -86, radiusNm: milesToNm(7) };
const base = Date.parse("2026-11-18T12:00:00Z");
const at = (minute: number) => new Date(base + minute * 60_000).toISOString();
/** `northMi` north of the center with the given flight state. */
const obs = (minute: number, northMi: number, state: Partial<EncounterObservation> = {}): EncounterObservation =>
  ({ icao24: "abc123", observedAt: at(minute), latitude: 40 + northMi / 69.05, longitude: -86, ...state });
const empty: EncounterState = { lastObservedAt: null, lastInside: false, openEncounterId: null };

describe("closest-point snapshot (migration 0008)", () => {
  it("records the flight state of the nearest recorded sample of a new encounter", () => {
    const result = advanceEncounters(empty, [
      obs(0, 6, { altitudeFt: 3000, altitudeSource: "barometric", groundSpeedKt: 120, trackDeg: 180 }),
      obs(1, 2, { altitudeFt: 1500, altitudeSource: "barometric", groundSpeedKt: 90, trackDeg: 175, verticalRateFpm: -500 }),
      obs(2, 5, { altitudeFt: 2500, altitudeSource: "barometric", groundSpeedKt: 110, trackDeg: 170 }),
    ], area);
    expect(result.started).toHaveLength(1);
    expect(result.started[0]!.closest).toMatchObject({ at: Date.parse(at(1)), altitudeFt: 1500, altitudeSource: "barometric", groundSpeedKt: 90, trackDeg: 175, verticalRateFpm: -500 });
  });

  it("keeps Unknown values as null instead of borrowing them from another sample", () => {
    const result = advanceEncounters(empty, [obs(0, 6, { altitudeFt: 3000, altitudeSource: "geometric", groundSpeedKt: 120 }), obs(1, 1)], area);
    expect(result.started[0]!.closest).toMatchObject({ at: Date.parse(at(1)), altitudeFt: null, altitudeSource: null, groundSpeedKt: null, trackDeg: null, onGround: null });
  });

  it("replaces the continued encounter's snapshot only with a closer sample", () => {
    const open: EncounterState = { lastObservedAt: Date.parse(at(0)), lastInside: true, openEncounterId: "open-id" };
    const result = advanceEncounters(open, [obs(1, 4, { altitudeFt: 2000, altitudeSource: "barometric" }), obs(2, 3, { altitudeFt: 1800, altitudeSource: "barometric" }), obs(3, 5, { altitudeFt: 2600, altitudeSource: "barometric" })], area);
    expect(result.continued!.closest).toMatchObject({ at: Date.parse(at(2)), altitudeFt: 1800 });
    expect(result.continued!.closestNm).toBeCloseTo(milesToNm(3), 2);
  });
});
