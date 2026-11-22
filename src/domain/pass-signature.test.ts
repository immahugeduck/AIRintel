import { describe, expect, it } from "vitest";
import type { NettedVisit } from "./netted";
import { aircraftHabits, commonLanes, describePath, describeWhen, isNewPattern, signPass } from "./pass-signature";

// SYNTHETIC TEST VECTORS ONLY: made-up passes; times are UTC and evaluated in UTC.
type Shape = { day?: number; hour?: number; mi?: number; alt?: number | null; kt?: number | null; track?: number | null; bearing?: number | null; stay?: number; ground?: boolean };
const pass = ({ day = 17, hour = 15, mi = 5, alt = 2000, kt = 90, track = 180, bearing = 90, stay = 2, ground = false }: Shape): NettedVisit => {
  const at = Date.UTC(2026, 10, day, hour, 0);
  return {
    enteredAt: new Date(at).toISOString(), lastSeenInRadiusAt: new Date(at + stay * 60_000).toISOString(), closestMi: mi, observationCount: 3, radiusMi: 7,
    closest: { at: new Date(at).toISOString(), latitude: 40, longitude: -86, altitudeFt: alt, altitudeSource: alt === null ? null : "barometric", groundSpeedKt: kt, trackDeg: track, verticalRateFpm: 0, onGround: ground, bearingFromCenterDeg: bearing, basis: "at_write" },
  };
};

describe("signPass", () => {
  it("bands altitude, speed, heading, side, dwell and time of day", () => {
    const signature = signPass(pass({ alt: 1600, kt: 80, track: 178, bearing: 95, stay: 2 }), 7, "UTC");
    expect(signature).toMatchObject({ altitude: "1k-3k", speed: "light", heading: "S", side: "E", dwell: "transit", dayPart: "afternoon", weekend: false });
    expect(describePath(signature!)).toBe("1,000–3,000 ft · 60–140 kt · heading S · passes your E side");
  });

  it("covers the edges: airliner at cruise, helicopter low and slow, on the ground, over the center", () => {
    expect(signPass(pass({ alt: 36000, kt: 460 }), 7, "UTC")).toMatchObject({ altitude: "10k-plus", speed: "very-fast" });
    expect(signPass(pass({ alt: 600, kt: 20 }), 7, "UTC")).toMatchObject({ altitude: "under-1k", speed: "slow", dwell: null });
    expect(signPass(pass({ alt: null, kt: 10, ground: true }), 7, "UTC")).toMatchObject({ altitude: "ground" });
    expect(signPass(pass({ mi: 0.5 }), 7, "UTC")).toMatchObject({ side: "over" });
  });

  it("calls a long stay lingering and leaves unsigned what it cannot know", () => {
    expect(signPass(pass({ kt: 90, mi: 1, stay: 30 }), 7, "UTC")).toMatchObject({ dwell: "lingered" });
    expect(signPass(pass({ kt: null }), 7, "UTC")).toBeNull();
    expect(signPass(pass({ track: null }), 7, "UTC")).toBeNull();
    expect(signPass({ ...pass({}), closest: null }, 7, "UTC")).toBeNull();
  });

  it("uses the viewer's time zone for time of day and weekends", () => {
    // Sun 2026-11-22 03:00 UTC is Sat 22:00 in Indianapolis.
    expect(signPass(pass({ day: 22, hour: 3 }), 7, "America/Indiana/Indianapolis")).toMatchObject({ dayPart: "evening", weekend: true });
  });
});

describe("habits, new patterns and lanes", () => {
  // Weekday afternoon laps on the E side, plus one evening pass low on the W side.
  const usual = [17, 18, 19, 20, 21].map((day) => pass({ day, hour: 15 }));
  const odd = pass({ day: 21, hour: 23, alt: 700, kt: 70, track: 0, bearing: 270 });
  const visits = [odd, ...usual]; // newest first, as served

  it("groups an aircraft's passes by path, most common first, with when they happen", () => {
    const habits = aircraftHabits(visits, 7, "UTC");
    expect(habits.signed).toBe(6);
    expect(habits.habits[0]).toMatchObject({ count: 5 });
    expect(describeWhen(habits.habits[0]!)).toBe("always weekday afternoons");
  });

  it("marks a path seen only once as new, but only with enough history", () => {
    const habits = aircraftHabits(visits, 7, "UTC");
    expect(isNewPattern(habits.perVisit[0]!, habits)).toBe(true);
    expect(isNewPattern(habits.perVisit[1]!, habits)).toBe(false);
    const short = aircraftHabits([odd, ...usual.slice(0, 2)], 7, "UTC");
    expect(isNewPattern(short.perVisit[0]!, short)).toBe(false);
  });

  it("finds lanes shared by several different aircraft", () => {
    const jet = (day: number) => pass({ day, alt: 34000, kt: 450, track: 45, bearing: 180 });
    const byAircraft = new Map([
      ["aaa001", aircraftHabits([jet(17)], 7, "UTC")],
      ["aaa002", aircraftHabits([jet(18), jet(19)], 7, "UTC")],
      ["aaa003", aircraftHabits([jet(20)], 7, "UTC")],
      ["bbb001", aircraftHabits(usual, 7, "UTC")],
    ]);
    const lanes = commonLanes(byAircraft);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ aircraft: 3, passes: 4 });
    expect(describePath(lanes[0]!.signature)).toBe("above 10,000 ft · over 250 kt · heading NE · passes your S side");
  });
});
