import { describe, expect, it } from "vitest";
import { normalizeNNumber } from "./profile";

describe("normalizeNNumber", () => {
  it("normalizes separators and casing", () => {
    expect(normalizeNNumber(" n-1 ")).toBe("N1");
  });

  it.each(["", "N0", "X1", "N123456", "N1I", "N1A2", "N12AB3"])("rejects an invalid registry identifier: %s", (value) => {
    expect(() => normalizeNNumber(value)).toThrow();
  });
});
