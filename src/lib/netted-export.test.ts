import { describe, expect, it } from "vitest";
import { nettedToCsv, nettedToJson } from "./netted-export";
const a = { icao24: "a1b2c3", callsign: "UAL1,2", registration: "=N1", aircraftTypeCode: "B738", visitCount: 2, firstSeenAt: "2026-10-29T10:00:00.000Z", lastSeenAt: "2026-10-29T12:00:00.000Z", closestApproachMi: 1.234, visits: [{ enteredAt: "2026-10-29T11:50:00.000Z", lastSeenInRadiusAt: "2026-10-29T12:00:00.000Z", closestMi: 1.5, observationCount: 4 }] };
describe("netted export", () => {
  it("csv escapes and guards", () => {
    const csv = nettedToCsv([a] as never);
    expect(csv.split("\r\n")[1]).toBe(`a1b2c3,"UAL1,2",'=N1,B738,2,2026-10-29T10:00:00.000Z,2026-10-29T12:00:00.000Z,1.23,2026-10-29T11:50:00.000Z,2026-10-29T12:00:00.000Z,1.50,4,,,,,,,,,,,`);
  });
  it("json has meta", () => {
    const j = JSON.parse(nettedToJson([a] as never, { radiusMi: 5, scope: "log", exportedAt: "x" }));
    expect(j.count).toBe(1); expect(j.aircraft[0].icao24).toBe("a1b2c3");
  });
});

describe("entries export", () => {
  it("adds the pass signature columns per entry", async () => {
    const { nettedEntriesToCsv, NETTED_ENTRY_CSV_COLUMNS } = await import("./netted-export");
    const at = "2026-11-17T15:00:00.000Z";
    const visit = { enteredAt: at, lastSeenInRadiusAt: "2026-11-17T15:02:00.000Z", closestMi: 5, observationCount: 3, radiusMi: 7,
      closest: { at, latitude: 40, longitude: -86, altitudeFt: 1600, altitudeSource: "barometric", groundSpeedKt: 80, trackDeg: 180, verticalRateFpm: 0, onGround: false, bearingFromCenterDeg: 90, basis: "at_write" } };
    const csv = nettedEntriesToCsv([{ ...a, callsign: "TEST1", registration: "N1", visits: [visit] }] as never, 7);
    const [header, row] = csv.split("\r\n");
    expect(header).toBe(NETTED_ENTRY_CSV_COLUMNS.join(","));
    const cells = row!.split(",");
    const col = (name: string) => cells[NETTED_ENTRY_CSV_COLUMNS.indexOf(name as never)];
    expect(col("sig_altitude_band")).toBe("1k-3k");
    expect(col("sig_heading")).toBe("S");
    expect(col("sig_side")).toBe("E");
    expect(col("sig_path_key")).toBe("1k-3k|light|S|E");
  });
});
