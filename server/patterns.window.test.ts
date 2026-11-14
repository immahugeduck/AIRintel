import { describe, expect, it } from "vitest";
import type { NettedAircraft } from "../src/domain/netted.js";
import { assessWindowPatterns, type WindowPositionRow } from "./patterns.js";

// TEST FIXTURES ONLY (unit test): a hand-written straight pass used to exercise the window-scope loader path.
const center = { latitude: 40, longitude: -86 };
const start = Date.UTC(2026, 9, 1, 15, 0);
const rows = (onGroundAtLow: boolean): WindowPositionRow[] => Array.from({ length: 25 }, (_, i) => {
  const nm = -4 + (8 * i) / 24;
  const d = Math.abs(nm);
  return {
    icao24: "abc123", latitude: center.latitude + nm / 60, longitude: center.longitude, observed_at: new Date(start + i * 30_000),
    altitude_ft: d <= 0.8 ? 1_100 : d <= 1.74 ? 1_800 : 2_600, ground_speed_kt: d <= 1.74 ? 70 : 105, track_deg: 0, vertical_rate_fpm: 0,
    on_ground: onGroundAtLow && d <= 0.8,
  };
});
const aircraft = [{
  icao24: "abc123", callsign: "N123AB", registration: "N123AB", aircraftTypeCode: "C172", visitCount: 1,
  firstSeenAt: new Date(start).toISOString(), lastSeenAt: new Date(start + 12 * 60_000).toISOString(), closestApproachMi: 0.1,
  visits: [{ enteredAt: new Date(start).toISOString(), lastSeenInRadiusAt: new Date(start + 12 * 60_000).toISOString(), closestMi: 0.1, observationCount: 25 }],
}] as unknown as NettedAircraft[];

describe("assessWindowPatterns", () => {
  it("scores a pass with a recorded on-ground low point as a touch-and-go, not a dip", () => {
    const grounded = assessWindowPatterns(aircraft, rows(true), center, 6).get("abc123")!;
    expect(grounded.reasons.some((r) => r.code === "touch_and_go")).toBe(true);
    expect(grounded.reasons.some((r) => r.code === "close_dip")).toBe(false);
    const airborne = assessWindowPatterns(aircraft, rows(false), center, 6).get("abc123")!;
    expect(airborne.reasons.some((r) => r.code === "close_dip")).toBe(true);
  });
});
