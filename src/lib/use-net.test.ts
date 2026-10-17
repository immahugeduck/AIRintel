import { describe, expect, it } from "vitest";
import { shouldAdoptServerArea, shouldSaveBrowserArea } from "./use-net";
import type { WatchArea } from "./watch-area";

const browser = (extra: Partial<WatchArea> = {}): WatchArea => ({ latitude: 40, longitude: -86, radiusMi: 7, source: "saved", updatedAt: "2026-10-17T12:00:00.000Z", ...extra });
const server = (extra: Partial<{ latitude: number; longitude: number; radiusMi: number; updatedAt: string }> = {}) => ({ latitude: 41, longitude: -87, radiusMi: 10, updatedAt: "2026-10-17T13:00:00.000Z", ...extra });

describe("account-backed watch area", () => {
  it("loads the account's area on a new device (default browser) or when it was changed more recently elsewhere", () => {
    expect(shouldAdoptServerArea(browser({ source: "default", updatedAt: null }), server())).toBe(true);
    expect(shouldAdoptServerArea(browser(), server())).toBe(true);
    expect(shouldAdoptServerArea(browser({ updatedAt: "2026-10-17T14:00:00.000Z" }), server())).toBe(false);
    expect(shouldAdoptServerArea(browser(), null)).toBe(false);
    expect(shouldAdoptServerArea(browser({ latitude: 41, longitude: -87, radiusMi: 10 }), server())).toBe(false);
  });

  it("saves a newer browser area to the account, but never a still-default browser", () => {
    expect(shouldSaveBrowserArea(browser(), null)).toBe(true);
    expect(shouldSaveBrowserArea(browser({ updatedAt: "2026-10-17T14:00:00.000Z" }), server())).toBe(true);
    expect(shouldSaveBrowserArea(browser(), server())).toBe(false);
    expect(shouldSaveBrowserArea(browser({ source: "default" }), null)).toBe(false);
  });
});
