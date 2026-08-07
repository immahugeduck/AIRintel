import { describe, expect, it } from "vitest";
import { validateHistorySearch } from "./history";

describe("validateHistorySearch", () => {
  it("accepts registration, ICAO24, and callsign character sets", () => {
    expect(validateHistorySearch(" N- ")).toBe("N-");
    expect(validateHistorySearch("abcdef")).toBe("abcdef");
  });

  it.each(["%", "_", ",", ".", "(", ")", "\n", "a" ])("rejects an unsafe or undersized query: %s", (query) => {
    expect(() => validateHistorySearch(query)).toThrow();
  });

  it("rejects overlength queries", () => {
    expect(() => validateHistorySearch("A".repeat(25))).toThrow();
  });
});
