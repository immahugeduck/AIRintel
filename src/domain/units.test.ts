import { describe, expect, it } from "vitest";
import { WATCH_RADIUS_MI, WATCH_RADIUS_NM, formatAltitudeFt, formatDistanceMi, formatLastSeen, formatSpeedMph, knotsToMph, milesToNm, nmToMiles } from "./units";

describe("unit conversions", () => {
  it("converts knots to statute mph", () => {
    expect(knotsToMph(1)).toBeCloseTo(1.150779, 6);
    expect(knotsToMph(100)).toBeCloseTo(115.0779, 3);
    expect(knotsToMph(0)).toBe(0);
  });

  it("converts nautical miles and statute miles both ways", () => {
    expect(nmToMiles(1)).toBeCloseTo(1.150779, 6);
    expect(milesToNm(1)).toBeCloseTo(0.868976, 6);
    expect(milesToNm(nmToMiles(12.34))).toBeCloseTo(12.34, 10);
  });

  it("defines the 7 statute mile watch radius explicitly", () => {
    expect(WATCH_RADIUS_MI).toBe(7);
    expect(WATCH_RADIUS_NM).toBeCloseTo(6.0828, 4);
  });
});

describe("display formatting", () => {
  it("formats distance in miles with one decimal", () => {
    expect(formatDistanceMi(2.78)).toBe("3.2 mi");
    expect(formatDistanceMi(0)).toBe("0.0 mi");
    expect(formatDistanceMi(null)).toBe("—");
  });

  it("formats altitude in feet with grouping and honest unknowns", () => {
    expect(formatAltitudeFt(4200)).toBe("4,200 ft");
    expect(formatAltitudeFt(35_012.6)).toBe("35,013 ft");
    expect(formatAltitudeFt(undefined)).toBe("—");
    expect(formatAltitudeFt(0, true)).toBe("Ground");
  });

  it("formats ground speed as rounded mph", () => {
    expect(formatSpeedMph(100)).toBe("115 mph");
    expect(formatSpeedMph(450)).toBe("518 mph");
    expect(formatSpeedMph(null)).toBe("—");
  });

  it("formats last seen as M/D/YY @ h:mmam/pm without leading zeros", () => {
    // 2026-10-08T20:40:00Z is 4:40 PM in America/Indiana/Indianapolis (UTC-4).
    expect(formatLastSeen("2026-10-08T20:40:00Z", "America/Indiana/Indianapolis")).toBe("10/8/26 @ 4:40pm");
    expect(formatLastSeen("2026-01-05T09:07:00Z", "UTC")).toBe("1/5/26 @ 9:07am");
    expect(formatLastSeen("2026-03-01T00:05:00Z", "UTC")).toBe("3/1/26 @ 12:05am");
    expect(formatLastSeen("2026-03-01T12:00:00Z", "UTC")).toBe("3/1/26 @ 12:00pm");
    expect(formatLastSeen("2026-12-31T23:59:00Z", "UTC")).toBe("12/31/26 @ 11:59pm");
  });

  it("converts to the viewer's zone across a date boundary", () => {
    expect(formatLastSeen("2026-10-09T02:15:00Z", "America/Los_Angeles")).toBe("10/8/26 @ 7:15pm");
  });

  it("returns an em dash for missing or invalid timestamps", () => {
    expect(formatLastSeen(null)).toBe("—");
    expect(formatLastSeen("not-a-date")).toBe("—");
  });
});
