import { describe, expect, it } from "vitest";
import { DEFAULT_AIRCRAFT_API_URL, DEFAULT_HISTORY_API_URL, DEFAULT_PROFILE_API_URL, resolveApiUrl } from "./api-url";

describe("resolveApiUrl", () => {
  it("resolves relative API paths against the page origin", () => {
    const url = resolveApiUrl("/api/aircraft-nearby");
    expect(url.pathname).toBe("/api/aircraft-nearby");
  });

  it("keeps absolute API hosts intact", () => {
    expect(resolveApiUrl("https://api.example.test/history").toString()).toBe("https://api.example.test/history");
  });
});

describe("same-origin defaults", () => {
  it("documents the Vercel-relative paths", () => {
    expect(DEFAULT_AIRCRAFT_API_URL).toBe("/api/aircraft-nearby");
    expect(DEFAULT_HISTORY_API_URL).toBe("/api/history");
    expect(DEFAULT_PROFILE_API_URL).toBe("/api/aircraft-profile");
  });
});
