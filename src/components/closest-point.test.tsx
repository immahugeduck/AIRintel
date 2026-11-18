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
