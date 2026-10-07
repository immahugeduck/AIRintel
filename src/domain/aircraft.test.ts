import { describe, expect, it } from "vitest";
import { gapDurationSeconds, radiusQuerySchema, summarizeRoute, summarizeTrackPoints, type TrackPoint } from "./aircraft";

describe("radiusQuerySchema", () => {
  it("caps public spatial queries", () => {
    expect(() => radiusQuerySchema.parse({ latitude: 0, longitude: 0, radiusNm: 101 })).toThrow();
  });
});

describe("gapDurationSeconds", () => {
  it("calculates an evidence gap from UTC timestamps", () => {
    expect(gapDurationSeconds("2026-08-06T12:00:30Z", "2026-08-06T12:04:00Z")).toBe(210);
  });
});

describe("summarizeTrackPoints", () => {
  it("derives sensible altitude and speed summaries from a track", () => {
    const points: TrackPoint[] = [
      {
        provider: "adsb",
        icao24: "a1b2c3",
        registration: "N12345",
        callsign: "AAL100",
        latitude: 39.0,
        longitude: -86.0,
        altitudeFt: 12000,
        altitudeSource: "barometric",
        groundSpeedKt: 420,
        trackDeg: 90,
        verticalRateFpm: 500,
        onGround: false,
        observedAt: "2026-08-06T12:00:00Z",
        receivedAt: "2026-08-06T12:00:02Z",
      },
      {
        provider: "adsb",
        icao24: "a1b2c3",
        registration: "N12345",
        callsign: "AAL100",
        latitude: 39.1,
        longitude: -86.1,
        altitudeFt: 14000,
        altitudeSource: "barometric",
        groundSpeedKt: 460,
        trackDeg: 95,
        verticalRateFpm: 400,
        onGround: false,
        observedAt: "2026-08-06T12:01:00Z",
        receivedAt: "2026-08-06T12:01:02Z",
      },
      {
        provider: "opensky",
        icao24: "a1b2c3",
        registration: "N12345",
        callsign: "AAL100",
        latitude: 39.2,
        longitude: -86.2,
        altitudeFt: null,
        altitudeSource: null,
        groundSpeedKt: null,
        trackDeg: null,
        verticalRateFpm: null,
        onGround: false,
        observedAt: "2026-08-06T12:02:00Z",
        receivedAt: "2026-08-06T12:02:02Z",
      },
    ];

    const summary = summarizeTrackPoints(points);

    expect(summary.pointCount).toBe(3);
    expect(summary.sourceCount).toBe(2);
    expect(summary.altitudeFt.min).toBe(12000);
    expect(summary.altitudeFt.max).toBe(14000);
    expect(summary.altitudeFt.average).toBe(13000);
    expect(summary.groundSpeedKt.max).toBe(460);
    expect(summary.groundSpeedKt.average).toBe(440);
  });
});

describe("summarizeRoute", () => {
  it("excludes reception gaps from distance and loitering", () => {
    const points: TrackPoint[] = [
      {
        provider: "adsb",
        icao24: "a1b2c3",
        registration: "N12345",
        callsign: "AAL100",
        latitude: 39.0,
        longitude: -86.0,
        altitudeFt: 12000,
        altitudeSource: "barometric",
        groundSpeedKt: 420,
        trackDeg: 90,
        verticalRateFpm: 500,
        onGround: false,
        observedAt: "2026-08-06T12:00:00Z",
        receivedAt: "2026-08-06T12:00:02Z",
      },
      {
        provider: "adsb",
        icao24: "a1b2c3",
        registration: "N12345",
        callsign: "AAL100",
        latitude: 39.0001,
        longitude: -86.0001,
        altitudeFt: 12100,
        altitudeSource: "barometric",
        groundSpeedKt: 430,
        trackDeg: 91,
        verticalRateFpm: 480,
        onGround: false,
        observedAt: "2026-08-06T12:05:00Z",
        receivedAt: "2026-08-06T12:05:02Z",
      },
      {
        provider: "adsb",
        icao24: "a1b2c3",
        registration: "N12345",
        callsign: "AAL100",
        latitude: 39.0002,
        longitude: -86.0002,
        altitudeFt: 12150,
        altitudeSource: "barometric",
        groundSpeedKt: 440,
        trackDeg: 92,
        verticalRateFpm: 460,
        onGround: false,
        observedAt: "2026-08-06T12:10:00Z",
        receivedAt: "2026-08-06T12:10:02Z",
      },
    ];

    const summary = summarizeRoute(points, 0.3, 5);

    expect(summary.pointCount).toBe(3);
    expect(summary.totalDistanceNm).toBe(0);
    expect(summary.loiteringDetected).toBe(false);
    expect(summary.loiteringMinutes).toBe(0);
    // Reuse the existing synthetic mathematical test vectors with continuous reception.
    const continuous = points.map((point, index) => ({ ...point, observedAt: new Date(Date.parse(points[0]!.observedAt) + index * 60_000).toISOString() }));
    const observed = summarizeRoute(continuous, 0.3, 1);
    expect(observed.totalDistanceNm).toBeGreaterThan(0);
    expect(observed.loiteringDetected).toBe(true);
    expect(observed.loiteringMinutes).toBe(2);
  });
});
