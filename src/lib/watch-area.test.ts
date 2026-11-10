import { describe, expect, it } from "vitest";
import { WATCH_AREA_STORAGE_KEY, clampRadiusMi, defaultWatchArea, loadWatchArea, recenterOn, shouldRecenter } from "./watch-area";

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

describe("follow me re-centering", () => {
  const base = { latitude: 39.7684, longitude: -86.1581, source: "device" as const };
  // ~0.0145 deg latitude ≈ 1 statute mile.
  it("moves only after the phone is more than 1 mile away", () => {
    expect(shouldRecenter(base, { latitude: 39.7684 + 0.0100, longitude: -86.1581, accuracyM: 20 })).toBe(false);
    expect(shouldRecenter(base, { latitude: 39.7684 + 0.0160, longitude: -86.1581, accuracyM: 20 })).toBe(true);
  });
  it("ignores imprecise fixes so GPS jitter never moves the circle", () => {
    expect(shouldRecenter(base, { latitude: 40.5, longitude: -86.1581, accuracyM: 5_000 })).toBe(false);
    expect(shouldRecenter(base, { latitude: 40.5, longitude: -86.1581, accuracyM: null })).toBe(true);
  });
  it("always replaces the deployment default with the first good fix", () => {
    expect(shouldRecenter({ ...base, source: "default" }, { latitude: 39.7685, longitude: -86.1581, accuracyM: 10 })).toBe(true);
  });
  it("recenterOn marks the area as a device fix with follow me on", () => {
    const next = recenterOn({ ...base, radiusMi: 7, updatedAt: null }, { latitude: 40, longitude: -86, accuracyM: 5 }, new Date("2026-11-10T00:00:00Z"));
    expect(next).toEqual({ latitude: 40, longitude: -86, radiusMi: 7, source: "device", followMe: true, updatedAt: "2026-11-10T00:00:00.000Z" });
  });
});
