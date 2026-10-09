import { describe, expect, it } from "vitest";
import { buildRadiusRows } from "./radius-list";
import { WATCH_RADIUS_NM } from "./units";

// TEST FIXTURES ONLY: synthetic positions used to exercise merge/sort logic; never shipped or shown as real data.
const center = { latitude: 40, longitude: -86 };
const north = (nm: number) => center.latitude + nm / 60.0405;
const iso = (minute: number) => new Date(Date.UTC(2026, 9, 8, 20, minute)).toISOString();

describe("buildRadiusRows", () => {
  it("keeps only aircraft inside the radius and sorts by distance ascending", () => {
    const rows = buildRadiusRows([
      { icao24: "aaa111", latitude: north(5), longitude: -86, observedAt: iso(1) },
      { icao24: "bbb222", latitude: north(1), longitude: -86, observedAt: iso(1) },
      { icao24: "ccc333", latitude: north(9), longitude: -86, observedAt: iso(1) },
    ], [], center, WATCH_RADIUS_NM);
    expect(rows.map((row) => row.icao24)).toEqual(["bbb222", "aaa111"]);
  });

  it("uses the latest observation per aircraft and keeps unknowns as null", () => {
    const rows = buildRadiusRows(
      [{ icao24: "AAA111", latitude: north(2), longitude: -86, observedAt: iso(5), groundSpeedKt: 120 }],
      [{ icao24: "aaa111", callsign: "TEST1", latitude: north(4), longitude: -86, observedAt: iso(1), altitudeFt: 3000 }],
      center, WATCH_RADIUS_NM,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ icao24: "aaa111", origin: "live", groundSpeedKt: 120, altitudeFt: null, callsign: "TEST1", observedAt: iso(5) });
    expect(rows[0]!.distanceNm).toBeCloseTo(2, 2);
  });
});
