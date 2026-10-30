import { describe, expect, it } from "vitest";
import { nettedToCsv, nettedToJson } from "./netted-export";
const a = { icao24: "a1b2c3", callsign: "UAL1,2", registration: "=N1", aircraftTypeCode: "B738", visitCount: 2, firstSeenAt: "2026-10-29T10:00:00.000Z", lastSeenAt: "2026-10-29T12:00:00.000Z", closestApproachMi: 1.234, visits: [{ enteredAt: "2026-10-29T11:50:00.000Z", lastSeenInRadiusAt: "2026-10-29T12:00:00.000Z", closestMi: 1.5, observationCount: 4 }] };
describe("netted export", () => {
  it("csv escapes and guards", () => {
    const csv = nettedToCsv([a] as never);
    expect(csv.split("\r\n")[1]).toBe(`a1b2c3,"UAL1,2",'=N1,B738,2,2026-10-29T10:00:00.000Z,2026-10-29T12:00:00.000Z,1.23,2026-10-29T11:50:00.000Z,2026-10-29T12:00:00.000Z,1.50,4`);
  });
  it("json has meta", () => {
    const j = JSON.parse(nettedToJson([a] as never, { radiusMi: 5, scope: "log", exportedAt: "x" }));
    expect(j.count).toBe(1); expect(j.aircraft[0].icao24).toBe("a1b2c3");
  });
});
