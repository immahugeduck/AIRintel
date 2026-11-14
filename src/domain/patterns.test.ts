import { describe, expect, it } from "vitest";
import { assessPattern, circlingEvidence, countSeparateCenters, dipContext, dipEvidence, headingDelta, localDay, longestDayStreak, phoneSightings, routineExplanation, sameDayRepeatDays, timeCorrelatedPlaces, type PatternInput, type PatternPosition, type PatternVisit } from "./patterns";

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

  it("does not let a training label excuse orbits centered on the watch center away from airports (v4)", () => {
    const result = assessPattern(base({ callsign: "LTA661", registration: "N661L", visitCount: 36, visits: [spatialOrbit(1, 20, 60, 1), spatialOrbit(2, 20, 60, 1), spatialOrbit(3, 20, 60, 1)] }));
    expect(result.context).toMatch(/LIFT/);
    expect(result.fit).toBe("not_explained");
    expect(result.tier).toBe("review");
    expect(result.reasons.find((r) => r.code === "context_mismatch")?.label).toMatch(/orbited your watch center/);
  });

  it("keeps a trainer doing turns around a point away from you routine (practice area, not centered on you)", () => {
    const visits = [1, 2, 3].map((day) => spatialOrbit(day, 20, 60, 1, { offsetNm: 4 }));
    const result = assessPattern(base({ callsign: "LTA661", registration: "N661L", visitCount: 36, visits }));
    expect(result.fit).toBe("consistent");
    expect(result.tier).toBe("routine");
  });

  it("explains circling low over a known airport as airport-area traffic", () => {
    const klaf = { latitude: 40.4123, longitude: -86.9369 };
    const visits = [1, 2, 3].map((day) => spatialOrbit(day, 30, 60, 0.6, { center: klaf, offsetNm: 0.5, altitudeFt: 1_800 }));
    const result = assessPattern(base({ callsign: "N12345", registration: "N12345", visitCount: 5, visits }));
    expect(result.reasons.some((r) => r.code === "airport_area")).toBe(true);
    expect(result.reasons.some((r) => r.code === "circling")).toBe(false);
    expect(result.tier).toBe("routine");
  });

  it("judges airport explanations per visit: pattern work at 2R2 does not excuse orbits over you elsewhere", () => {
    const field = { latitude: 39.7467, longitude: -86.4753 };
    const pattern = [1, 2].map((day) => spatialOrbit(day, 20, 60, 0.6, { center: field, offsetNm: 0.5, altitudeFt: 1_700 }));
    const overYou = [3, 4, 5].map((day) => spatialOrbit(day, 20, 60, 3));
    const result = assessPattern(base({ visitCount: 5, visits: [...pattern, ...overYou] }));
    expect(result.reasons.find((r) => r.code === "airport_area")?.weight).toBe(-1);
    expect(result.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["circling", "centered_orbit"]));
    expect(["review", "priority"]).toContain(result.tier);
  });

  it("scores a BOLDFlight 172 working the 2R2 pattern near a Danville watch center as routine and consistent", () => {
    const hospital = { latitude: 39.7615, longitude: -86.5025 }; // ~1.6 NM WNW of 2R2
    const field = { latitude: 39.7467, longitude: -86.4753 };
    const visits = [1, 3, 5, 8, 12].map((day) => ({ ...spatialOrbit(day, 25, 60, 0.6, { center: field, offsetNm: 0.6, altitudeFt: 1_650 }), center: hospital }));
    const result = assessPattern(base({ icao24: "a6c277", callsign: "N5346D", registration: "N5346D", aircraftTypeCode: "C172", visitCount: 32, visits, identity: { registrantKind: "business", registrantName: "BOLDFLIGHT LLC" } }));
    expect(result.context).toMatch(/BOLDFlight/);
    expect(result.fit).toBe("consistent");
    expect(result.tier).toBe("routine");
  });

  it("flags a charter jet that circles away from airports as not explained by its label", () => {
    const result = assessPattern(base({ callsign: "EJA123", registration: "N123QS", visitCount: 2, visits: [spatialOrbit(1, 20, 60, 3, { offsetNm: 4, speedKt: 200, altitudeFt: 5_000 })] }));
    expect(result.fit).toBe("not_explained");
    expect(result.tier).not.toBe("routine");
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

  it("lets same-day location correlation pull a training fleet out of routine (v4: no label explains being followed)", () => {
    const sightings = [{ enteredAt: t(1, 0), latitude: 40, longitude: -86 }, { enteredAt: t(1, 90), latitude: 40.4, longitude: -86.9 }];
    const result = assessPattern(base({ callsign: "PDU56", registration: "N856PU", visitCount: 6, visits: [straightPass(1, 6, 60), straightPass(2, 6, 60), straightPass(3, 6, 60)], sightings }));
    expect(result.fit).toBe("not_explained");
    expect(result.reasons.some((r) => r.code === "followed_locations")).toBe(true);
    expect(result.tier).toBe("review");
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

// v5 fixtures: a straight pass due north through CENTER, every 30 s, with altitude/speed shaped by distance from center.
const shapedPass = (day: number, shape: (distanceNm: number, after: boolean) => { altitudeFt: number; groundSpeedKt: number }, hourUtc = 15): PatternVisit => {
  const positions: PatternPosition[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const nm = -4 + (8 * i) / 24; // −4 NM … +4 NM
    const { altitudeFt, groundSpeedKt } = shape(Math.abs(nm), nm > 0);
    positions.push({ observedAt: new Date(Date.parse(t(day, 0, hourUtc)) + i * 30_000).toISOString(), latitude: CENTER.latitude + nm / NM_PER_DEG_LAT, longitude: CENTER.longitude, altitudeFt, groundSpeedKt, trackDeg: 0, verticalRateFpm: 0 });
  }
  return { enteredAt: t(day, 0, hourUtc), lastSeenInRadiusAt: t(day, 12, hourUtc), center: CENTER, positions };
};
const dipShape = (d: number) => (d <= 1.74 ? { altitudeFt: 2_000, groundSpeedKt: 75 } : { altitudeFt: 2_600, groundSpeedKt: 110 });

describe("v5: dips within 2 mi of the watch center", () => {
  it("detects an altitude and speed dip that recovers after passing", () => {
    const d = dipEvidence(shapedPass(1, dipShape));
    expect(d.assessable).toBe(true);
    expect(d.altitudeDip && d.speedDip).toBe(true);
    expect(Math.round(d.altitudeDropFt)).toBe(600);
  });

  it("treats a drop that does not recover as a descent, not a dip", () => {
    const d = dipEvidence(shapedPass(1, (dist, after) => (after || dist <= 1.74 ? { altitudeFt: 1_800, groundSpeedKt: 80 } : { altitudeFt: 2_600, groundSpeedKt: 110 })));
    expect(d.altitudeDip).toBe(false);
    expect(d.speedDip).toBe(false);
  });

  it("ignores small wobbles below 300 ft and 15 kt", () => {
    const d = dipEvidence(shapedPass(1, (dist) => (dist <= 1.74 ? { altitudeFt: 2_450, groundSpeedKt: 100 } : { altitudeFt: 2_600, groundSpeedKt: 110 })));
    expect(d.altitudeDip || d.speedDip).toBe(false);
  });

  it("does not count a second pass through the zone as recovery from the first (Codex review, PR #32)", () => {
    // In, out low for one sample, back in high, then out low: no position outside the zone ever recovered.
    const alt = [2_600, 2_600, 2_000, 2_000, 2_000, 3_000, 3_000, 2_000];
    const dist = [3, 2.5, 1.5, 1, 2.2, 1.2, 1.0, 2.5];
    const positions: PatternPosition[] = alt.map((a, i) => ({ observedAt: t(1, i), latitude: CENTER.latitude + dist[i]! / NM_PER_DEG_LAT, longitude: CENTER.longitude, altitudeFt: a, groundSpeedKt: 100, trackDeg: 0, verticalRateFpm: 0 }));
    const d = dipEvidence({ enteredAt: t(1, 0), lastSeenInRadiusAt: t(1, 7), center: CENTER, positions });
    expect(d.altitudeDip).toBe(false);
  });

  it("says Unknown when there are no positions on both sides of the 2 mi zone", () => {
    expect(dipEvidence(straightPass(1, 1, 60)).assessable).toBe(false);
  });

  it("reports how many passes were dip-checked, so 'no dip' is never confused with 'not checked'", () => {
    const flat = shapedPass(1, () => ({ altitudeFt: 2_600, groundSpeedKt: 110 }));
    const sparse = straightPass(2, 1, 60);
    const result = assessPattern(base({ visitCount: 2, visits: [flat, sparse] }));
    expect(result.reasons.find((r) => r.code === "no_close_dip")?.label).toMatch(/no altitude dip on 1 checked pass; no speed dip on 1 checked pass/);
    expect(result.reasons.find((r) => r.code === "dip_unknown")?.label).toMatch(/1 pass had no recorded positions/);
  });

  it("never claims 'no altitude dip' when altitude was not reported (Codex review, PR #33)", () => {
    const noAlt = shapedPass(1, () => ({ altitudeFt: 2_600, groundSpeedKt: 110 }));
    const visit = { ...noAlt, positions: noAlt.positions.map((p) => ({ ...p, altitudeFt: null })) };
    const d = dipEvidence(visit);
    expect(d.speedChecked && !d.altitudeChecked).toBe(true);
    const result = assessPattern(base({ visits: [visit] }));
    const negative = result.reasons.find((r) => r.code === "no_close_dip")?.label ?? "";
    expect(negative).toMatch(/no speed dip/);
    expect(negative).not.toMatch(/altitude/);
    expect(result.reasons.find((r) => r.code === "dip_unknown")?.label).toMatch(/altitude was not reported on 1 pass/);
  });

  it("scores repeated dips and calls them unexplained even for a training fleet", () => {
    const visits = [1, 2].map((day) => shapedPass(day, dipShape));
    const plain = assessPattern(base({ visitCount: 2, visits }));
    expect(plain.reasons.find((r) => r.code === "close_dip")?.weight).toBe(3);
    const trainer = assessPattern(base({ callsign: "LTA661", registration: "N661L", visitCount: 2, visits }));
    expect(trainer.fit).toBe("not_explained");
    expect(trainer.tier).not.toBe("routine");
  });
});

describe("v5: streaks and same-day repeats with the radius on your phone", () => {
  const follow = (day: number, hourUtc = 15) => ({ enteredAt: t(day, 0, hourUtc), latitude: 40, longitude: -86, centerMode: "follow" as const });
  const fixed = (day: number) => ({ enteredAt: t(day, 0), latitude: 40, longitude: -86, centerMode: "fixed" as const });

  it("counts the longest run of consecutive local days", () => {
    expect(longestDayStreak(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05", "2026-10-06"])).toBe(3);
    expect(longestDayStreak(["2026-10-30", "2026-10-31", "2026-11-01"])).toBe(3);
  });

  it("uses only follow-mode sightings when any are tagged", () => {
    const { list, modeKnown } = phoneSightings([follow(1), fixed(2), follow(3)]);
    expect(modeKnown).toBe(true);
    expect(list).toHaveLength(2);
  });

  it("scores 5+ days in a row near your phone, more at 7+", () => {
    const five = assessPattern(base({ visits: [straightPass(1, 6, 60)], sightings: [1, 2, 3, 4, 5].map((d) => follow(d)) }));
    expect(five.reasons.find((r) => r.code === "consecutive_days")?.weight).toBe(2);
    const seven = assessPattern(base({ visits: [straightPass(1, 6, 60)], sightings: [1, 2, 3, 4, 5, 6, 7].map((d) => follow(d)) }));
    expect(seven.reasons.find((r) => r.code === "consecutive_days")?.weight).toBe(3);
    const broken = assessPattern(base({ visits: [straightPass(1, 6, 60)], sightings: [1, 2, 4, 5, 7].map((d) => follow(d)) }));
    expect(broken.reasons.some((r) => r.code === "consecutive_days")).toBe(false);
  });

  it("does not count days the radius was fixed toward a phone streak", () => {
    const result = assessPattern(base({ visits: [straightPass(1, 6, 60)], sightings: [follow(1), follow(2), fixed(3), follow(4), follow(5)] }));
    expect(result.reasons.some((r) => r.code === "consecutive_days")).toBe(false);
  });

  it("counts passes hours apart on the same day, not two pings minutes apart", () => {
    expect(sameDayRepeatDays([t(1, 0, 14), t(1, 30, 14)]).days).toBe(0);
    expect(sameDayRepeatDays([t(1, 0, 14), t(1, 0, 17), t(1, 0, 20)])).toEqual({ days: 1, maxEntriesInDay: 3 });
    const result = assessPattern(base({ visits: [straightPass(1, 6, 60)], sightings: [follow(1, 14), follow(1, 18), follow(2, 14), follow(2, 19), follow(3, 13), follow(3, 17)] }));
    expect(result.reasons.find((r) => r.code === "same_day_repeat")?.weight).toBe(2);
  });

  it("never applies streak or repeat scoring to scheduled airline flight numbers", () => {
    const result = assessPattern(base({ callsign: "SWA461", visits: [straightPass(1, 3, 30, { altitudeFt: 36_000, groundSpeedKt: 450 })], sightings: [1, 2, 3, 4, 5, 6, 7].map((d) => follow(d)) }));
    expect(result.reasons.some((r) => r.code === "consecutive_days" || r.code === "same_day_repeat")).toBe(false);
    expect(result.tier).toBe("routine");
  });
});

describe("touch-and-go and near-field dips", () => {
  const r2 = { latitude: 39.7467, longitude: -86.4753 }; // 2R2, field elevation 898 ft
  // Straight pass due north through `c`; inside 2 mi the aircraft drops to `lowFt` and slows, then climbs back out.
  const passOver = (day: number, c: { latitude: number; longitude: number }, lowFt: number, highFt = 2_000): PatternVisit => {
    const positions: PatternPosition[] = [];
    for (let i = 0; i <= 24; i += 1) {
      const nm = -4 + (8 * i) / 24;
      const d = Math.abs(nm);
      // Bottoms out within 0.8 NM of `c`, halfway down elsewhere inside the 2 mi zone.
      const altitudeFt = d <= 0.8 ? lowFt : d <= 1.74 ? (lowFt + highFt) / 2 : highFt;
      positions.push({ observedAt: new Date(Date.parse(t(day, 0)) + i * 30_000).toISOString(), latitude: c.latitude + nm / NM_PER_DEG_LAT, longitude: c.longitude, altitudeFt, groundSpeedKt: d <= 1.74 ? 70 : 105, trackDeg: 0, verticalRateFpm: 0 });
    }
    return { enteredAt: t(day, 0), lastSeenInRadiusAt: t(day, 12), center: c, positions };
  };

  it("reads a low point reported on the ground as a touch-and-go anywhere", () => {
    expect(dipContext({ latitude: 40, longitude: -86, altitudeFt: 0 })).toEqual({ kind: "touch_and_go", field: null, onGround: true });
  });

  it("reads a low point within 100 ft of a known field's elevation as a touch-and-go at that field", () => {
    expect(dipContext({ ...r2, altitudeFt: 960 })).toEqual({ kind: "touch_and_go", field: "2R2", onGround: false });
    expect(dipContext({ ...r2, altitudeFt: 1_300 })).toEqual({ kind: "near_field", field: "2R2" });
    expect(dipContext({ latitude: 40, longitude: -86, altitudeFt: 960 })).toEqual({ kind: "open" });
  });

  // A private strip right under the watch center (test-only entry; the real list is filled from verified FAA data).
  const strip = [{ id: "TEST1", latitude: CENTER.latitude, longitude: CENTER.longitude, elevationFt: 850 }];

  it("does not score a touch-and-go at a private strip", () => {
    const result = assessPattern(base({ visits: [passOver(1, CENTER, 920)], extraAirstrips: strip }));
    expect(result.reasons.find((r) => r.code === "touch_and_go")?.label).toMatch(/TEST1/);
    expect(result.reasons.some((r) => r.code === "close_dip" || r.code === "near_field_dip")).toBe(false);
  });

  it("counts a higher dip near a private strip at 0.5 per pass, capped at 1.5", () => {
    const one = assessPattern(base({ visits: [passOver(1, CENTER, 1_400)], extraAirstrips: strip }));
    expect(one.reasons.find((r) => r.code === "near_field_dip")?.weight).toBe(0.5);
    expect(one.reasons.some((r) => r.code === "close_dip")).toBe(false);
    const many = assessPattern(base({ visits: [1, 2, 3, 4].map((d) => passOver(d, CENTER, 1_400)), extraAirstrips: strip }));
    expect(many.reasons.find((r) => r.code === "near_field_dip")?.weight).toBe(1.5);
  });

  it("treats an on-ground report as a touch-and-go even with no strip on file", () => {
    const result = assessPattern(base({ visits: [passOver(1, CENTER, 0)] }));
    expect(result.reasons.find((r) => r.code === "touch_and_go")?.evidence).toBe("Observed");
    expect(result.reasons.some((r) => r.code === "close_dip")).toBe(false);
  });

  it("keeps full weight for repeated dips in open country", () => {
    const visits = [1, 2].map((day) => passOver(day, CENTER, 1_400));
    const result = assessPattern(base({ visits }));
    expect(result.reasons.find((r) => r.code === "close_dip")?.weight).toBe(3);
    expect(result.reasons.some((r) => r.code === "near_field_dip" || r.code === "touch_and_go")).toBe(false);
  });
});
