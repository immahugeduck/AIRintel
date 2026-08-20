import { describe, expect, it } from "vitest";
import { noradIdFromTle, parseCelestrakTleText, parseTleEpoch, satellitePassSchema } from "./satellite";

const TEST_TLE_1 = "1 25544U 98067A   26190.50000000  .00000000  00000-0  00000-0 0  9990";
const TEST_TLE_2 = "2 25544  51.6400 120.0000 0005000  10.0000 350.0000 15.50000000123456";

describe("parseTleEpoch", () => {
  it("converts a TLE day-of-year epoch to UTC", () => {
    expect(parseTleEpoch(TEST_TLE_1)).toBe("2026-07-09T12:00:00.000Z");
  });
});

describe("noradIdFromTle", () => {
  it("requires the catalog number to agree across both TLE lines", () => {
    expect(noradIdFromTle(TEST_TLE_1, TEST_TLE_2)).toBe("25544");
    expect(() => noradIdFromTle(TEST_TLE_1, TEST_TLE_2.replace("25544", "12345"))).toThrow("mismatch");
  });
});

describe("parseCelestrakTleText", () => {
  it("preserves source and element provenance for a named 3LE record", () => {
    const [record] = parseCelestrakTleText({
      text: `TEST OBJECT\n${TEST_TLE_1}\n${TEST_TLE_2}\n`,
      group: "STATIONS",
      retrievedAt: "2026-08-10T12:00:00Z",
      sourceUrl: "https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=TLE",
    });

    expect(record?.name).toBe("TEST OBJECT");
    expect(record?.noradId).toBe("25544");
    expect(record?.elementEpoch).toBe("2026-07-09T12:00:00.000Z");
    expect(record?.retrievedAt).toBe("2026-08-10T12:00:00Z");
  });

  it("uses a neutral NORAD label when a 2LE source omits a name", () => {
    const [record] = parseCelestrakTleText({
      text: `${TEST_TLE_1}\n${TEST_TLE_2}\n`,
      group: "VISUAL",
      retrievedAt: "2026-08-10T12:00:00Z",
      sourceUrl: "https://celestrak.org/NORAD/elements/gp.php?GROUP=VISUAL&FORMAT=TLE",
    });

    expect(record?.name).toBe("NORAD 25544");
  });
});

describe("satellitePassSchema", () => {
  it("rejects a pass with a non-positive duration", () => {
    expect(() => satellitePassSchema.parse({
      evidenceClass: "calculated",
      provider: "celestrak",
      propagationLibrary: "satellite.js",
      propagationVersion: "7.0.1",
      noradId: "25544",
      name: "TEST OBJECT",
      group: "STATIONS",
      elementEpoch: "2026-07-09T12:00:00Z",
      sourceRetrievedAt: "2026-08-10T12:00:00Z",
      riseAt: "2026-08-10T12:00:00Z",
      setAt: "2026-08-10T12:00:00Z",
      riseAzimuthDeg: 100,
      setAzimuthDeg: 220,
      peakAt: "2026-08-10T12:00:00Z",
      peakElevationDeg: 45,
      peakAzimuthDeg: 160,
      durationSeconds: 0,
    })).toThrow();
  });
});
