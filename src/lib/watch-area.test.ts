import { describe, expect, it } from "vitest";
import { WATCH_AREA_STORAGE_KEY, clampRadiusMi, defaultWatchArea, loadWatchArea } from "./watch-area";

const storage = (value: string | null) => ({ getItem: (key: string) => (key === WATCH_AREA_STORAGE_KEY ? value : null) });

describe("watch area", () => {
  it("defaults to a 7 statute mile radius", () => {
    expect(defaultWatchArea({}).radiusMi).toBe(7);
    expect(defaultWatchArea({ lat: "40", lon: "-85", radiusMi: "12" })).toMatchObject({ latitude: 40, longitude: -85, radiusMi: 12, source: "default" });
  });

  it("clamps the radius to 1-50 mi", () => {
    expect(clampRadiusMi(0)).toBe(1);
    expect(clampRadiusMi(500)).toBe(50);
  });

  it("restores a valid saved location and rejects tampered storage", () => {
    const saved = { latitude: 41, longitude: -87, radiusMi: 7, source: "device", updatedAt: "2026-10-08T20:40:00.000Z" };
    expect(loadWatchArea(storage(JSON.stringify(saved)))).toEqual(saved);
    expect(loadWatchArea(storage(JSON.stringify({ ...saved, latitude: 300 }))).source).toBe("default");
    expect(loadWatchArea(storage("{not json")).source).toBe("default");
  });
});
