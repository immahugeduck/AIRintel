import { describe, expect, it } from "vitest";
import { shouldAdoptServerArea, shouldClearForeignArea, shouldSaveBrowserArea } from "./use-net";
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

  // Sign-in happened at 11:00; browser() was chosen at 12:00, i.e. during this signed-in session.
  const session = Date.parse("2026-10-17T11:00:00.000Z");
  const leftover = browser({ updatedAt: "2026-10-17T10:00:00.000Z" }); // stored before sign-in (maybe another person)

  it("saves an area chosen during this signed-in session when it is newer than the account's, never a default one", () => {
    expect(shouldSaveBrowserArea(browser(), null, session)).toBe(true);
    expect(shouldSaveBrowserArea(browser({ updatedAt: "2026-10-17T14:00:00.000Z" }), server(), session)).toBe(true);
    expect(shouldSaveBrowserArea(browser(), server(), session)).toBe(false);
    expect(shouldSaveBrowserArea(browser({ source: "default" }), null, session)).toBe(false);
  });

  it("never uploads an area left in the browser from before sign-in into an account that has none", () => {
    expect(shouldSaveBrowserArea(leftover, null, session)).toBe(false);
    expect(shouldSaveBrowserArea(browser({ updatedAt: null }), null, session)).toBe(false);
  });

  it("clears that leftover area instead, but keeps areas the account owns or the user just chose", () => {
    expect(shouldClearForeignArea(leftover, null, session)).toBe(true);
    expect(shouldClearForeignArea(leftover, server(), session)).toBe(false); // the account's area is adopted instead
    expect(shouldClearForeignArea(browser(), null, session)).toBe(false);
    expect(shouldClearForeignArea(browser({ source: "default", updatedAt: null }), null, session)).toBe(false);
  });
});
