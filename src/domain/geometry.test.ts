import { describe, expect, it } from "vitest";
import { distanceNm, watchAreaBounds } from "./geometry";

describe("nautical-mile geometry (mathematical test vectors, not aircraft observations)", () => {
  it("uses nautical miles rather than statute miles", () => {
    expect(distanceNm(0, 0, 0, 1)).toBeCloseTo(60.04, 2);
    expect(distanceNm(60, 0, 60, 1)).toBeCloseTo(30.02, 2);
  });
  it("crosses the date line using the short distance", () => {
    expect(distanceNm(0, 179.5, 0, -179.5)).toBeCloseTo(60.04, 2);
  });
  it("keeps antipodal and identical distances finite", () => {
    expect(distanceNm(0, 0, 0, 0)).toBe(0);
    expect(Number.isFinite(distanceNm(0, 0, 0, 180))).toBe(true);
  });
  it("fits a watch radius without a mounted Leaflet circle", () => {
    const [[south, west], [north, east]] = watchAreaBounds(40, -86, 20);
    expect(south).toBeLessThan(40); expect(north).toBeGreaterThan(40);
    expect(west).toBeLessThan(-86); expect(east).toBeGreaterThan(-86);
    expect(distanceNm(40, -86, north, -86)).toBeCloseTo(20, 8);
  });
  it("handles poles and date-line bounds without NaN", () => {
    for (const latitude of [-90, 90]) expect(watchAreaBounds(latitude, 0, 100).flat().every(Number.isFinite)).toBe(true);
    const [[, west], [, east]] = watchAreaBounds(0, 179.9, 20);
    expect(west).toBeLessThan(179.9); expect(east).toBeGreaterThan(180);
  });
});
