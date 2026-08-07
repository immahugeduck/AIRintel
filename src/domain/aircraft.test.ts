import { describe, expect, it } from "vitest";
import { observationSchema, radiusQuerySchema } from "./aircraft";

const validObservation = {
  provider: "documented-provider",
  icao24: "a1b2c3",
  latitude: 39.7684,
  longitude: -86.1581,
  altitudeFt: 2500,
  altitudeSource: "barometric" as const,
  groundSpeedKt: 112,
  trackDeg: 275,
  observedAt: "2026-08-06T12:00:00Z",
  receivedAt: "2026-08-06T12:00:01Z",
};

describe("observationSchema", () => {
  it("accepts a sourced observation and normalizes ICAO casing", () => {
    const parsed = observationSchema.parse({ ...validObservation, icao24: "A1B2C3" });
    expect(parsed.icao24).toBe("a1b2c3");
  });

  it("rejects missing altitude provenance", () => {
    const { altitudeSource: _removed, ...withoutSource } = validObservation;
    expect(() => observationSchema.parse(withoutSource)).toThrow(/Altitude provenance/);
  });

  it("rejects invalid coordinates and headings", () => {
    expect(() => observationSchema.parse({ ...validObservation, latitude: 91 })).toThrow();
    expect(() => observationSchema.parse({ ...validObservation, trackDeg: 360 })).toThrow();
  });
});

describe("radiusQuerySchema", () => {
  it("caps public spatial queries", () => {
    expect(() => radiusQuerySchema.parse({ latitude: 0, longitude: 0, radiusNm: 101 })).toThrow();
  });
});
