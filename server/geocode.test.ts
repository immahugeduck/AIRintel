import { describe, expect, it, vi } from "vitest";
import { geocode } from "./geocode.js";

// SYNTHETIC TEST VECTORS ONLY: hand-written response shapes for the Census and Nominatim APIs, not captured payloads.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const censusMatch = { result: { addressMatches: [{ matchedAddress: "TEST ADDRESS, TESTVILLE, IN, 00000", coordinates: { x: -86.5, y: 39.5 } }] } };
const censusEmpty = { result: { addressMatches: [] } };
const nominatimMatch = [{ lat: "39.25", lon: "-86.25", display_name: "Testville, Test County, Indiana" }];

const routed = (census: () => Response, nominatim: () => Response) =>
  vi.fn(async (input: string | URL | Request) => (String(input).includes("census.gov") ? census() : nominatim())) as unknown as typeof fetch;

describe("geocode", () => {
  it("answers typed coordinates without any network call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await geocode("39.5, -86.5", fetchImpl)).toMatchObject({ status: "found", result: { source: "coordinates" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prefers the Census match", async () => {
    const outcome = await geocode("1 Test St, Testville, IN", routed(() => json(censusMatch), () => json(nominatimMatch)));
    expect(outcome).toEqual({ status: "found", result: { latitude: 39.5, longitude: -86.5, label: "TEST ADDRESS, TESTVILLE, IN, 00000", source: "us_census" } });
  });

  it("falls back to OpenStreetMap for place names Census cannot match", async () => {
    const outcome = await geocode("Testville, Indiana", routed(() => json(censusEmpty), () => json(nominatimMatch)));
    expect(outcome).toMatchObject({ status: "found", result: { latitude: 39.25, longitude: -86.25, source: "openstreetmap" } });
  });

  it("falls back when Census errors, and reports not_found / unavailable distinctly", async () => {
    expect(await geocode("Testville, Indiana", routed(() => json({}, 503), () => json(nominatimMatch)))).toMatchObject({ status: "found" });
    expect(await geocode("Nowhere at all", routed(() => json(censusEmpty), () => json([])))).toEqual({ status: "not_found" });
    expect(await geocode("Nowhere at all", routed(() => json({}, 500), () => json({}, 500)))).toEqual({ status: "unavailable" });
  });

  it("rejects input that is too short or too long", async () => {
    expect(await geocode("ab")).toEqual({ status: "invalid" });
    expect(await geocode("x".repeat(201))).toEqual({ status: "invalid" });
    expect(await geocode(undefined)).toEqual({ status: "invalid" });
  });
});
