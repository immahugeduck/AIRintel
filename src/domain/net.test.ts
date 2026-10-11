import { describe, expect, it } from "vitest";
import { NET_STALE_AFTER_MINUTES, deriveNetStatus, describeNetStatus, formatAgo, watchAreaInputSchema } from "./net";

// TEST FIXTURES ONLY: fixed timestamps.
const NOW = new Date("2026-10-11T17:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const area = (extra: Partial<Parameters<typeof deriveNetStatus>[0] & object> = {}) => ({ enabled: true, updatedAt: ago(60), lastSuccessAt: ago(2), lastPolledAt: ago(2), lastPollStatus: "ok", ...extra });

describe("deriveNetStatus", () => {
  it("is paused with no area or when disabled", () => {
    expect(deriveNetStatus(null, NOW).state).toBe("paused");
    expect(deriveNetStatus(area({ enabled: false }), NOW).state).toBe("paused");
  });
  it("is active within 15 minutes of the last successful sweep and stale after", () => {
    expect(deriveNetStatus(area({ lastSuccessAt: ago(NET_STALE_AFTER_MINUTES - 1) }), NOW).state).toBe("active");
    expect(deriveNetStatus(area({ lastSuccessAt: ago(NET_STALE_AFTER_MINUTES + 1) }), NOW).state).toBe("stale");
  });
  it("gives a freshly enabled net a grace period (pending) before it counts as stale", () => {
    expect(deriveNetStatus(area({ lastSuccessAt: null, lastPolledAt: null, lastPollStatus: null, updatedAt: ago(3) }), NOW).state).toBe("pending");
    expect(deriveNetStatus(area({ lastSuccessAt: null, lastPolledAt: null, lastPollStatus: null, updatedAt: ago(30) }), NOW).state).toBe("stale");
  });
});

describe("status wording", () => {
  it("formats relative times", () => {
    expect(formatAgo(ago(0), NOW)).toBe("just now");
    expect(formatAgo(ago(2), NOW)).toBe("2 min ago");
    expect(formatAgo(ago(180), NOW)).toBe("3 h ago");
    expect(formatAgo(ago(60 * 72), NOW)).toBe("3 d ago");
    expect(formatAgo(null, NOW)).toBeNull();
    expect(formatAgo("garbage", NOW)).toBeNull();
  });
  it("describes each state honestly", () => {
    expect(describeNetStatus(deriveNetStatus(area(), NOW), NOW)).toEqual({ tone: "ok", text: "Net active — last sweep 2 min ago" });
    expect(describeNetStatus(deriveNetStatus(null, NOW), NOW)).toEqual({ tone: "idle", text: "Net paused" });
    const stale = describeNetStatus(deriveNetStatus(area({ lastSuccessAt: ago(40), lastPollStatus: "provider_error" }), NOW), NOW);
    expect(stale.tone).toBe("warn");
    expect(stale.text).toContain("no successful sweep since 40 min ago");
    expect(stale.text).toContain("provider error");
  });
});

describe("watchAreaInputSchema", () => {
  it("defaults the radius to 7 mi and is strict", () => {
    expect(watchAreaInputSchema.parse({ latitude: 1, longitude: 2, enabled: true }).radiusMi).toBe(7);
    expect(watchAreaInputSchema.safeParse({ latitude: 1, longitude: 2, enabled: true, extra: 1 }).success).toBe(false);
  });
});
