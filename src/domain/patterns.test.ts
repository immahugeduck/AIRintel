import { describe, expect, it } from "vitest";
import { assessPattern, circlingEvidence, countSeparateCenters, headingDelta, localDay, routineExplanation, timeCorrelatedPlaces, type PatternInput, type PatternPosition, type PatternVisit } from "./patterns";

// TEST FIXTURES ONLY: hand-written synthetic geometry used to exercise the pattern rules.
// They are not provider data and are never shipped in the application bundle.
const CENTER = { latitude: 40, longitude: -86 };
const t = (day: number, minute: number, hourUtc = 15) => new Date(Date.UTC(2026, 9, day, hourUtc, 0) + minute * 60_000).toISOString();
const pos = (day: number, minute: number, extra: Partial<PatternPosition> = {}): PatternPosition => ({
  observedAt: t(day, minute), latitude: CENTER.latitude + 0.005, longitude: CENTER.longitude, altitudeFt: 2_500, groundSpeedKt: 95, trackDeg: null, verticalRateFpm: 0, ...extra,
});
const NM_PER_DEG_LAT = 60;
/**
 * A real orbit in space: constant turn rate (deg/s) and ground speed, sampled every `stepSec`, around a point offset
 * `offsetNm` north of CENTER. Radius follows from speed and turn rate (standard rate 3°/s at 100 kt ≈ 0.53 NM).
 */
const spatialOrbit = (day: number, minutes: number, stepSec: number, degPerSec: number, opts: { speedKt?: number; altitudeFt?: number; offsetNm?: number; center?: { latitude: number; longitude: number } } = {}): PatternVisit => {
  const speed = opts.speedKt ?? 100;
  const radiusNm = speed / 3600 / (degPerSec * Math.PI / 180);
  const c = opts.center ?? CENTER;
  const oLat = c.latitude + (opts.offsetNm ?? 0) / NM_PER_DEG_LAT;
  const positions: PatternPosition[] = [];
  for (let s = 0; s <= minutes * 60; s += stepSec) {
    const angle = (s * degPerSec) % 360;
    const rad = angle * Math.PI / 180;
    positions.push({
      observedAt: new Date(Date.parse(t(day, 0)) + s * 1000).toISOString(),
      latitude: oLat + (radiusNm * Math.cos(rad)) / NM_PER_DEG_LAT,
      longitude: c.longitude + (radiusNm * Math.sin(rad)) / (NM_PER_DEG_LAT * Math.cos(oLat * Math.PI / 180)),
      altitudeFt: opts.altitudeFt ?? 2_000, groundSpeedKt: speed, trackDeg: (angle + 90) % 360, verticalRateFpm: 0,
    });
  }
  return { enteredAt: t(day, 0), lastSeenInRadiusAt: t(day, minutes), center: c, positions };
};
/** A straight pass due north at `speedKt`, sampled every `stepSec`. */
const straightPass = (day: number, minutes: number, stepSec: number, extra: Partial<PatternPosition> = {}, center = CENTER): PatternVisit => {
  const speed = extra.groundSpeedKt ?? 110;
  const positions: PatternPosition[] = [];
  for (let s = 0; s <= minutes * 60; s += stepSec) {
    const nm = (speed * s) / 3600 - (speed * minutes) / 120;
    positions.push({ observedAt: new Date(Date.parse(t(day, 0)) + s * 1000).toISOString(), latitude: center.latitude + nm / NM_PER_DEG_LAT, longitude: center.longitude, altitudeFt: 2_500, groundSpeedKt: speed, trackDeg: 0, verticalRateFpm: 0, ...extra });
  }
  return { enteredAt: t(day, 0), lastSeenInRadiusAt: t(day, minutes), center, positions };
};
const base = (overrides: Partial<PatternInput>): PatternInput => ({ icao24: "abc123", callsign: "N123AB", registration: "N123AB", aircraftTypeCode: "C182", visitCount: 1, visits: [], sightings: [], ...overrides });

describe("heading math", () => {
  it("wraps across north", () => {
    expect(headingDelta(350, 10)).toBe(20);
    expect(headingDelta(10, 350)).toBe(-20);
  });
});

describe("circling from position geometry", () => {
  it.each([
    ["standard-rate orbit, 60 s sampling", 60, 3],
    ["standard-rate orbit, 5 min sampling", 300, 3],
    ["slow 1°/s orbit, 60 s sampling", 60, 1],
    ["slow 1°/s orbit, 5 min sampling", 300, 1],
    ["standard-rate orbit, 5 s sampling", 5, 3],
  ])("detects a %s", (_label, step, rate) => {
    const evidence = circlingEvidence(spatialOrbit(1, 30, step, rate).positions);
    expect(evidence.circling).toBe(true);
    expect(evidence.spreadNm).toBeLessThan(2);
  });

  it("measures the winding angle when sampling is dense enough to follow the turn", () => {
    const evidence = circlingEvidence(spatialOrbit(1, 12, 10, 1).positions);
    expect(evidence.method).toBe("winding");
    expect(evidence.turnDeg).toBeGreaterThan(600);
  });

  it("does not call a straight pass circling at either sampling rate", () => {
    expect(circlingEvidence(straightPass(1, 6, 60).positions).circling).toBe(false);
    expect(circlingEvidence(straightPass(1, 10, 300).positions).circling).toBe(false);
  });

  it("needs at least three positions over a few minutes before judging", () => {
    const evidence = circlingEvidence(spatialOrbit(1, 1, 60, 3).positions);
    expect(evidence.assessable).toBe(false);
    expect(evidence.circling).toBe(false);
  });

  it("does not treat a hovering or parked aircraft as circling", () => {
    const hover = Array.from({ length: 10 }, (_, i) => pos(1, i, { groundSpeedKt: 5 }));
    expect(circlingEvidence(hover).circling).toBe(false);
  });
});

describe("routine explanations (pass 1)", () => {
  it("recognizes scheduled airlines, charter operators and the configured local training fleets", () => {
    expect(routineExplanation({ callsign: "SWA461", registration: null })?.code).toBe("scheduled_operator");
    expect(routineExplanation({ callsign: "EJA123", registration: null })?.code).toBe("charter_operator");
    expect(routineExplanation({ callsign: "LTA661", registration: "N661L" })?.label).toMatch(/LIFT/);
    expect(routineExplanation({ callsign: "N69VU", registration: "N69VU" })?.label).toMatch(/Vincennes/);
    expect(routineExplanation({ callsign: "PDU56", registration: "N856PU" })?.label).toMatch(/Purdue/);
    expect(routineExplanation({ callsign: "N734PK", registration: "N734PK", registrantName: "PURDUE AVIATION LLC" })?.label).toMatch(/Purdue/);
    expect(routineExplanation({ callsign: "ISU52", registration: "N152RA" })?.label).toMatch(/Indiana State/);
    expect(routineExplanation({ callsign: "CXK661", registration: "N23172" })?.label).toMatch(/ATP/);
    expect(routineExplanation({ callsign: "N367TW", registration: null, registryRegistration: "N367TW" })?.label).toMatch(/Tom Wood/);
    expect(routineExplanation({ callsign: "N8274N", registration: "N8274N" })).toBeNull();
  });

  it("keeps a circling training aircraft routine (turns around a point are a training maneuver)", () => {
    const result = assessPattern(base({ callsign: "LTA661", registration: "N661L", visitCount: 36, visits: [spatialOrbit(1, 20, 60, 1), spatialOrbit(2, 20, 60, 1), spatialOrbit(3, 20, 60, 1)] }));
    expect(result.tier).toBe("routine");
    expect(result.explainedBy).toMatch(/LIFT/);
    expect(result.score).toBeLessThanOrEqual(0);
  });

  it("explains circling low over a known airport as traffic-pattern work", () => {
    const klaf = { latitude: 40.4123, longitude: -86.9369 };
    const visits = [1, 2, 3].map((day) => spatialOrbit(day, 30, 60, 0.6, { center: klaf, offsetNm: 0.5, altitudeFt: 1_800 }));
    const result = assessPattern(base({ callsign: "N12345", registration: "N12345", visitCount: 5, visits }));
    expect(result.reasons.some((r) => r.code === "airport_pattern")).toBe(true);
    expect(result.tier).toBe("routine");
  });

  it("treats cruise-altitude transit as routine", () => {
    const result = assessPattern(base({ callsign: null, visits: [straightPass(1, 4, 60, { altitudeFt: 35_000, groundSpeedKt: 450 })] }));
    expect(result.reasons.some((r) => r.code === "cruise_transit")).toBe(true);
    expect(result.tier).not.toBe("priority");
  });
});

describe("behavior and location passes (2 and 3)", () => {
  it("raises an unexplained aircraft that repeatedly orbits over the watch center", () => {
    const result = assessPattern(base({ visitCount: 6, visits: [spatialOrbit(1, 20, 60, 3), spatialOrbit(3, 20, 300, 3), spatialOrbit(5, 20, 60, 1)] }));
    expect(result.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["circling", "centered_orbit", "loiter", "low_slow", "recurrence"]));
    expect(result.tier).toBe("priority");
    expect(result.coverage).toBe("ok");
  });

  it("leaves a single straight low pass at low priority", () => {
    const result = assessPattern(base({ visits: [straightPass(1, 6, 60)] }));
    expect(result.tier).toBe("low");
  });

  it("only counts the same aircraft at two of your places when the sightings are hours apart, not months", () => {
    const home = { latitude: 40, longitude: -86 };
    const work = { latitude: 40.4, longitude: -86.9 }; // ~48 NM away
    const sameDay = [{ enteredAt: t(1, 0), ...home }, { enteredAt: t(1, 120), ...work }];
    const monthsApart = [{ enteredAt: t(1, 0), ...home }, { enteredAt: new Date(Date.UTC(2026, 11, 20, 15)).toISOString(), ...work }];
    expect(timeCorrelatedPlaces(sameDay).pairs).toBe(1);
    expect(timeCorrelatedPlaces(monthsApart).pairs).toBe(0);
    const correlated = assessPattern(base({ visits: [straightPass(1, 6, 60)], sightings: sameDay }));
    expect(correlated.reasons.find((r) => r.code === "followed_locations")?.weight).toBeGreaterThanOrEqual(4);
    const distant = assessPattern(base({ visits: [straightPass(1, 6, 60)], sightings: monthsApart }));
    expect(distant.reasons.some((r) => r.code === "followed_locations")).toBe(false);
    expect(distant.reasons.find((r) => r.code === "separate_places")?.weight).toBe(1);
  });

  it("does not let location correlation pull a known training fleet out of routine", () => {
    const sightings = [{ enteredAt: t(1, 0), latitude: 40, longitude: -86 }, { enteredAt: t(1, 90), latitude: 40.4, longitude: -86.9 }];
    const result = assessPattern(base({ callsign: "PDU56", registration: "N856PU", visitCount: 6, visits: [straightPass(1, 6, 60), straightPass(2, 6, 60), straightPass(3, 6, 60)], sightings }));
    expect(result.tier).toBe("routine");
  });

  it("scores the Purdue trainer from the 2026-11-10 review as routine, not priority 7", () => {
    const home = { latitude: 39.77, longitude: -86.16 };
    const work = { latitude: 40.43, longitude: -86.91 };
    const v = (day: number, c: typeof home) => straightPass(day, 6, 120, { groundSpeedKt: 95 }, c);
    const result = assessPattern(base({ icao24: "abbefa", callsign: "PDU56", registration: "N856PU", aircraftTypeCode: "P28A", visitCount: 6, visits: [v(1, home), v(2, work), v(3, home)], sightings: [{ enteredAt: t(1, 0), ...home }, { enteredAt: t(2, 0), ...work }, { enteredAt: t(3, 0), ...home }] }));
    expect(result.tier).toBe("routine");
  });

  it("does not count nearby or overlapping watch circles as separate locations", () => {
    expect(countSeparateCenters([{ latitude: 40, longitude: -86 }, { latitude: 40.02, longitude: -86.02 }])).toBe(1);
    expect(countSeparateCenters([{ latitude: 39.67, longitude: -86.58 }, { latitude: 39.64, longitude: -86.78 }])).toBe(1);
  });

  it("never escalates a cruise-altitude airliner on location correlation", () => {
    const sightings = [{ enteredAt: t(1, 0), latitude: 40, longitude: -86 }, { enteredAt: t(1, 60), latitude: 40, longitude: -86.9 }];
    const result = assessPattern(base({ callsign: "SWA2198", visits: [straightPass(1, 3, 30, { altitudeFt: 38_000, groundSpeedKt: 450 })], sightings }));
    expect(result.tier).toBe("routine");
    expect(result.reasons.some((r) => r.code === "followed_locations")).toBe(false);
  });
});

describe("minimum evidence", () => {
  it("says there is not enough data instead of scoring an aircraft with one or two positions", () => {
    const result = assessPattern(base({ callsign: null, visits: [{ enteredAt: t(1, 0), lastSeenInRadiusAt: t(1, 1), center: CENTER, positions: [pos(1, 0), pos(1, 1)] }] }));
    expect(result.coverage).toBe("sparse");
    expect(result.tier).toBe("insufficient");
    expect(result.reasons.find((r) => r.code === "sparse_coverage")?.evidence).toBe("Unknown");
  });

  it("caps sparse aircraft at review even with strong identity signals", () => {
    const sparse = { enteredAt: t(1, 0), lastSeenInRadiusAt: t(1, 1), center: CENTER, positions: [pos(1, 0)] };
    const result = assessPattern(base({ callsign: null, registration: null, visitCount: 8, visits: [sparse, { ...sparse, enteredAt: t(2, 0), lastSeenInRadiusAt: t(2, 1) }, { ...sparse, enteredAt: t(3, 0), lastSeenInRadiusAt: t(3, 1) }], identity: { dbFlags: 1, registrantKind: "government", registrantName: "SYNTHETIC COUNTY SHERIFF" } }));
    expect(result.score).toBeGreaterThanOrEqual(7);
    expect(result.tier).toBe("review");
  });

  it("notes when positions were downsampled", () => {
    const visit = { ...spatialOrbit(1, 20, 60, 3), downsampled: true };
    expect(assessPattern(base({ visits: [visit] })).reasons.some((r) => r.code === "downsampled")).toBe(true);
  });
});

describe("identity signals", () => {
  const orbitVisits = [spatialOrbit(1, 20, 60, 1)];
  it("reads adsb.lol database flags (military, PIA, LADD)", () => {
    const codes = (flags: number) => assessPattern(base({ visits: orbitVisits, identity: { dbFlags: flags } })).reasons.map((r) => r.code);
    expect(codes(1)).toContain("military_flag");
    expect(codes(4)).toContain("privacy_address");
    expect(codes(8)).toContain("ladd");
    expect(codes(0)).not.toEqual(expect.arrayContaining(["military_flag", "privacy_address", "ladd"]));
  });

  it("separates government agencies from public universities in the FAA owner type", () => {
    const agency = assessPattern(base({ visits: orbitVisits, identity: { registrantKind: "government", registrantName: "SYNTHETIC COUNTY SHERIFF" } }));
    expect(agency.reasons.find((r) => r.code === "government_owner")?.weight).toBe(2);
    const university = assessPattern(base({ visits: orbitVisits, identity: { registrantKind: "government", registrantName: "SYNTHETIC STATE UNIVERSITY" } }));
    expect(university.reasons.some((r) => r.code === "government_owner")).toBe(false);
    const company = assessPattern(base({ visits: orbitVisits, identity: { registrantKind: "business", registrantName: "SYNTHETIC LLC" } }));
    expect(company.reasons.some((r) => r.code === "government_owner")).toBe(false);
  });

  it("adds a rotorcraft note only when the aircraft circled or loitered", () => {
    const loiter = assessPattern(base({ visits: [spatialOrbit(1, 20, 60, 1)], identity: { category: "A7" } }));
    expect(loiter.reasons.some((r) => r.code === "rotorcraft_loiter")).toBe(true);
    const pass = assessPattern(base({ visits: [straightPass(1, 6, 60)], identity: { faaAircraftType: "6" } }));
    expect(pass.reasons.some((r) => r.code === "rotorcraft_loiter")).toBe(false);
  });
});

describe("local days", () => {
  it("counts days in America/Indianapolis, not UTC", () => {
    // 9:30 PM EST on Nov 1 is 02:30 UTC on Nov 2.
    expect(localDay("2026-11-02T02:30:00Z", "America/Indianapolis")).toBe("2026-11-01");
    expect(localDay("2026-11-02T02:30:00Z", "UTC")).toBe("2026-11-02");
  });

  it("does not count an evening flight as two days of recurrence", () => {
    const evening = (day: number) => ({ enteredAt: new Date(Date.UTC(2026, 10, day, 1, 0)).toISOString(), lastSeenInRadiusAt: new Date(Date.UTC(2026, 10, day, 1, 5)).toISOString(), center: CENTER, positions: [] });
    const result = assessPattern(base({ visitCount: 5, visits: [evening(2), evening(3), { ...evening(2), enteredAt: "2026-11-01T22:00:00Z", lastSeenInRadiusAt: "2026-11-01T22:05:00Z" }] }));
    // Local days: Nov 1 (twice) and Nov 2 -> 2 days, below the 3-day recurrence threshold.
    expect(result.reasons.some((r) => r.code === "recurrence")).toBe(false);
  });
});
