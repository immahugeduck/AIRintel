import { describe, expect, it } from "vitest";
import { parseCoordinateText } from "./geocode";

describe("parseCoordinateText", () => {
  it("reads decimal lat, lon with comma or space", () => {
    expect(parseCoordinateText("39.64, -86.86")).toMatchObject({ latitude: 39.64, longitude: -86.86, source: "coordinates" });
    expect(parseCoordinateText(" 39.64 -86.86 ")).toMatchObject({ latitude: 39.64, longitude: -86.86 });
  });

  it("leaves addresses and out-of-range numbers to the geocoder", () => {
    expect(parseCoordinateText("123 Main St, Springfield, IL")).toBeNull();
    expect(parseCoordinateText("95, 10")).toBeNull();
    expect(parseCoordinateText("45, 200")).toBeNull();
  });
});
