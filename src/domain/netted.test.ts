import { describe, expect, it } from "vitest";
import { countRadiusVisits, nettedQuerySchema, type VisitObservation } from "./netted";
import { WATCH_RADIUS_NM } from "./units";

// TEST FIXTURES ONLY: hand-written synthetic coordinates used to exercise the visit algorithm.
// They are not provider data and are never shipped in the application bundle.
const CENTER = { latitude: 40, longitude: -86 };
const NM_PER_DEGREE_LAT = 60.0405; // haversine with EARTH_RADIUS_NM = 3440.065
const at = (northNm: number) => CENTER.latitude + northNm / NM_PER_DEGREE_LAT;
const t = (minute: number) => new Date(Date.UTC(2026, 9, 8, 20, 0) + minute * 60_000).toISOString();
const obs = (icao24: string, minute: number, northNm: number, extra: Partial<VisitObservation> = {}): VisitObservation =>
  ({ icao24, observedAt: t(minute), latitude: at(northNm), longitude: CENTER.longitude, ...extra });
const run = (input: VisitObservation[], gapMinutes = 10) => countRadiusVisits(input, { ...CENTER, radiusNm: WATCH_RADIUS_NM, gapMinutes });

describe("countRadiusVisits (netted-visits-v1)", () => {
  it("counts one visit for a continuous pass through the radius", () => {
    const [summary] = run([obs("abc123", 0, 10), obs("abc123", 1, 5), obs("abc123", 2, 1), obs("abc123", 3, -4), obs("abc123", 4, -9)]);
    expect(summary).toMatchObject({ icao24: "abc123", visitCount: 1, firstSeenAt: t(1), lastSeenAt: t(3) });
    expect(summary!.closestApproachNm).toBeCloseTo(1, 2);
  });

  it("counts a second visit after the aircraft exits and re-enters", () => {
    const [summary] = run([obs("abc123", 0, 2), obs("abc123", 2, 8), obs("abc123", 4, 3), obs("abc123", 5, 9), obs("abc123", 7, 1)]);
    expect(summary!.visitCount).toBe(3);
  });

  it("starts a new visit after a reception gap longer than the gap threshold, even if still inside", () => {
    const [summary] = run([obs("abc123", 0, 2), obs("abc123", 5, 2), obs("abc123", 16, 2), obs("abc123", 26, 2)]);
    // 0->5 continues, 5->16 is an 11 min gap (new visit), 16->26 is exactly 10 min (continues).
    expect(summary!.visitCount).toBe(2);
  });

  it("ignores aircraft that were never inside the radius", () => {
    expect(run([obs("def456", 0, 7), obs("def456", 1, 6.5)])).toEqual([]);
  });

  it("treats the boundary as inside and sorts input by time", () => {
    const [summary] = run([obs("abc123", 3, 1), obs("abc123", 1, WATCH_RADIUS_NM - 1e-9)]);
    expect(summary).toMatchObject({ visitCount: 1, firstSeenAt: t(1), lastSeenAt: t(3) });
  });

  it("keys aircraft by icao24 and keeps the latest observed identity", () => {
    const result = run([
      obs("AAA111", 0, 1, { callsign: "SWA12" }),
      obs("aaa111", 1, 1, { callsign: "SWA12 ", registration: "N123AB" }),
      obs("bbb222", 0, 2),
      obs("bbb222", 30, 2),
    ]);
    expect(result).toHaveLength(2);
    const aaa = result.find((item) => item.icao24 === "aaa111")!;
    const bbb = result.find((item) => item.icao24 === "bbb222")!;
    expect(aaa).toMatchObject({ visitCount: 1, callsign: "SWA12", registration: "N123AB" });
    expect(bbb).toMatchObject({ visitCount: 2, callsign: null, registration: null });
    expect(result[0]!.icao24).toBe("bbb222"); // most recent first
  });

  it("skips unparseable timestamps instead of guessing", () => {
    expect(run([{ icao24: "abc123", observedAt: "nope", latitude: CENTER.latitude, longitude: CENTER.longitude }])).toEqual([]);
  });
});

describe("nettedQuerySchema", () => {
  it("defaults to the 7 mile radius and 24 hours", () => {
    expect(nettedQuerySchema.parse({ lat: "39.7", lon: "-86.1" })).toEqual({ lat: 39.7, lon: -86.1, radiusMi: 7, hours: 24 });
  });

  it.each([{ lat: "91", lon: "0" }, { lat: "0", lon: "181" }, { lat: "0", lon: "0", radiusMi: "0.5" }, { lat: "0", lon: "0", radiusMi: "51" }, { lat: "0", lon: "0", hours: "169" }, { lat: "x", lon: "0" }])("rejects %o", (input) => {
    expect(nettedQuerySchema.safeParse(input).success).toBe(false);
  });
});

describe("visits list (netted-visits-v1)", () => {
  it("exposes each entry with entered / last-seen-in-radius / closest approach, chronologically", () => {
    const [summary] = run([obs("abc123", 0, 2), obs("abc123", 1, 1), obs("abc123", 2, 9), obs("abc123", 30, 3), obs("abc123", 31, 5)]);
    expect(summary!.visits).toEqual([
      { enteredAt: t(0), lastSeenInRadiusAt: t(1), closestApproachNm: expect.closeTo(1, 2), observationCount: 2 },
      { enteredAt: t(30), lastSeenInRadiusAt: t(31), closestApproachNm: expect.closeTo(3, 2), observationCount: 2 },
    ]);
    expect(summary!.visits).toHaveLength(summary!.visitCount);
  });

  it("does not double count when the live view and the sweep both wrote the same pass (duplicate / near-duplicate rows)", () => {
    const base = [obs("abc123", 0, 10), obs("abc123", 1, 4), obs("abc123", 2, 1), obs("abc123", 3, 5), obs("abc123", 4, 11)];
    // The same pass recorded again by a second writer: identical rows plus rows 40 ms apart (different provider record ids).
    const skew = (item: VisitObservation) => ({ ...item, observedAt: new Date(Date.parse(item.observedAt) + 40).toISOString() });
    const twice = [...base, ...base, ...base.map(skew)];
    const [single] = run(base);
    const [doubled] = run(twice);
    expect(doubled!.visitCount).toBe(1);
    expect(doubled!.visitCount).toBe(single!.visitCount);
    expect(doubled!.visits).toHaveLength(1);
    expect(doubled!.closestApproachNm).toBeCloseTo(single!.closestApproachNm, 6);
  });

  it("reception gaps beyond 10 minutes give separate entries whether or not outside samples exist in between", () => {
    // Inside at 0, no data, inside at 15 (gap rule => new visit); with outside samples between, still 2 visits.
    const sparse = run([obs("abc123", 0, 2), obs("abc123", 15, 2)])[0]!;
    const dense = run([obs("abc123", 0, 2), obs("abc123", 5, 9), obs("abc123", 10, 9), obs("abc123", 15, 2)])[0]!;
    expect(sparse.visitCount).toBe(2);
    expect(dense.visitCount).toBe(2);
  });
});
