import { describe, expect, it } from "vitest";
import { replayIndexAt, replayWindowSchema } from "./replay";

// Deterministic timestamp vectors only; no aircraft or provider records.
describe("timestamp replay", () => {
  it("holds the last recorded sample through a gap instead of jumping ahead", () => {
    expect(replayIndexAt([0, 20_000, 140_000], 80_000)).toBe(1);
    expect(replayIndexAt([0, 20_000, 140_000], 140_000)).toBe(2);
    expect(replayIndexAt([0], -1)).toBe(0);
  });
  it("chooses the last simultaneous observation deterministically", () => {
    expect(replayIndexAt([0, 0, 1], 0)).toBe(1);
  });
  it("requires a paired positive window no longer than 24 hours", () => {
    const start = "2026-11-01T00:00:00Z";
    expect(replayWindowSchema.safeParse({ start, end: start }).success).toBe(false);
    expect(replayWindowSchema.safeParse({ start }).success).toBe(false);
    expect(replayWindowSchema.safeParse({ start, end: "2026-11-02T00:00:01Z" }).success).toBe(false);
    expect(replayWindowSchema.safeParse({ start, end: "2026-11-02T00:00:00Z" }).success).toBe(true);
  });
});
