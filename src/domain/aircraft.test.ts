import { describe, expect, it } from "vitest";
import { gapDurationSeconds, radiusQuerySchema } from "./aircraft";

describe("radiusQuerySchema", () => {
  it("caps public spatial queries", () => {
    expect(() => radiusQuerySchema.parse({ latitude: 0, longitude: 0, radiusNm: 101 })).toThrow();
  });
});

describe("gapDurationSeconds", () => {
  it("calculates an evidence gap from UTC timestamps", () => {
    expect(gapDurationSeconds("2026-08-06T12:00:30Z", "2026-08-06T12:04:00Z")).toBe(210);
  });
});
