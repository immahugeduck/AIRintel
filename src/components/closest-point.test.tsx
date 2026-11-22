import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClosestPointLine, VisitTimeline } from "./NettedPanel";
import type { NettedAircraft, NettedVisit } from "../domain/netted";

// SYNTHETIC UI VECTORS ONLY, not real aircraft or encounters.
const visit = (minute: number, closestMi: number, altitudeFt: number | null, speedKt: number | null): NettedVisit => {
  const entered = Date.UTC(2026, 10, 18, 15, minute);
  return {
    enteredAt: new Date(entered).toISOString(), lastSeenInRadiusAt: new Date(entered + 60_000).toISOString(), closestMi, observationCount: 2,
    closest: { at: new Date(entered + 30_000).toISOString(), latitude: 40, longitude: -86, altitudeFt, altitudeSource: "barometric", groundSpeedKt: speedKt, trackDeg: 180, verticalRateFpm: 0, onGround: false, bearingFromCenterDeg: 45, basis: "at_write" },
  };
};

describe("closest-point presentation", () => {
  it("shows altitude, speed, heading, side of center and time at the closest point", () => {
    const html = renderToStaticMarkup(<ClosestPointLine visit={visit(0, 4.8, 1350, 70)} timeZone="UTC" />);
    expect(html).toContain("At closest:");
    expect(html).toContain("1,350 ft · 81 mph · heading S · 4.8 mi NE of center · at 3:00:30pm");
  });

  it("says plainly when an entry has no closest-point details", () => {
    expect(renderToStaticMarkup(<ClosestPointLine visit={{ ...visit(0, 4, 1000, 70), closest: null }} />)).toContain("not recorded for this entry");
  });

  it("shows the typical pass and flags an unusual one in the entry log", () => {
    const visits = [visit(50, 2, 600, 60), visit(40, 6, 3000, 100), visit(30, 6.1, 3100, 100), visit(20, 5.9, 2900, 95), visit(10, 6, 3000, 105)];
    const item = { icao24: "abcdef", callsign: "TEST1", registration: null, aircraftTypeCode: null, visitCount: 5, firstSeenAt: visits[4]!.enteredAt, lastSeenAt: visits[0]!.lastSeenInRadiusAt, closestApproachMi: 2, visits } as NettedAircraft;
    const html = renderToStaticMarkup(<VisitTimeline item={item} timeZone="UTC" defaultOpen />);
    expect(html).toContain("Typical pass");
    expect(html).toContain("closest 6.0 mi · 3,000 ft");
    expect(html).toContain("Closer than usual");
    expect(html).toContain("Lower than usual");
  });
});

describe("pass signatures in the panel", () => {
  const lap = (day: number, hour = 15, extra: Partial<NonNullable<NettedVisit["closest"]>> = {}): NettedVisit => {
    const at = Date.UTC(2026, 10, day, hour, 0);
    return { enteredAt: new Date(at).toISOString(), lastSeenInRadiusAt: new Date(at + 120_000).toISOString(), closestMi: 6, observationCount: 3, radiusMi: 7,
      closest: { at: new Date(at).toISOString(), latitude: 40, longitude: -86, altitudeFt: 1600, altitudeSource: "barometric", groundSpeedKt: 80, trackDeg: 180, verticalRateFpm: 0, onGround: false, bearingFromCenterDeg: 45, basis: "at_write", ...extra } };
  };

  it("shows the usual pass, when it happens, and flags a new pattern in the entry log", async () => {
    const { HabitLine } = await import("./NettedPanel");
    const { aircraftHabits } = await import("../domain/pass-signature");
    const visits = [lap(21, 23, { altitudeFt: 700, trackDeg: 0, bearingFromCenterDeg: 270 }), lap(17), lap(18), lap(19), lap(20)];
    const habits = aircraftHabits(visits, 7, "UTC");
    const line = renderToStaticMarkup(<HabitLine habits={habits} laneAircraft={new Map()} />);
    expect(line).toContain("Usual pass");
    expect(line).toContain("(4 of 5)");
    expect(line).toContain("1,000–3,000 ft · 60–140 kt · heading S · passes your E side");
    expect(line).toContain("always weekday afternoons");
    expect(line).toContain("Its own path");
    const item = { icao24: "abcdef", callsign: "TEST1", registration: null, aircraftTypeCode: null, visitCount: 5, firstSeenAt: visits[4]!.enteredAt, lastSeenAt: visits[0]!.lastSeenInRadiusAt, closestApproachMi: 6, visits } as NettedAircraft;
    const log = renderToStaticMarkup(<VisitTimeline item={item} timeZone="UTC" defaultOpen radiusMi={7} habits={habits} />);
    expect(log.match(/New pattern for this aircraft/g)).toHaveLength(1);
  });

  it("labels a usual pass that other aircraft share as a common lane", async () => {
    const { HabitLine } = await import("./NettedPanel");
    const { aircraftHabits } = await import("../domain/pass-signature");
    const habits = aircraftHabits([lap(17), lap(18)], 7, "UTC");
    expect(renderToStaticMarkup(<HabitLine habits={habits} laneAircraft={new Map([[habits.habits[0]!.key, 6]])} />)).toContain("Common lane · 6 aircraft");
  });
});
