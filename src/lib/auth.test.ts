import { describe, expect, it } from "vitest";
import { getAccessToken, getAuthClient, pickNeonAuthUrl } from "./auth";

describe("Neon Auth browser client", () => {
  it("is not created and yields no token when no Neon Auth URL is set", async () => {
    expect(getAuthClient()).toBeNull();
    expect(await getAccessToken()).toBeNull();
  });

  it("prefers VITE_NEON_AUTH_URL and falls back to SERVERSIDE_NEON_VITE_NEON_AUTH_URL", () => {
    expect(pickNeonAuthUrl("https://plain.example/auth", "https://prefixed.example/auth")).toBe("https://plain.example/auth");
    expect(pickNeonAuthUrl(undefined, " https://prefixed.example/auth ")).toBe("https://prefixed.example/auth");
    expect(pickNeonAuthUrl("  ", "https://prefixed.example/auth")).toBe("https://prefixed.example/auth");
    expect(pickNeonAuthUrl(undefined, undefined)).toBeUndefined();
    expect(pickNeonAuthUrl("", " ")).toBeUndefined();
  });
});
