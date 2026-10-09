import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

const PLAIN = "https://plain.example/neondb/auth";
const PREFIXED = "https://serverside.example/neondb/auth";

describe("readConfig Neon Auth URLs", () => {
  it("uses the plain NEON_AUTH_* names", () => {
    const config = readConfig({ NEON_AUTH_BASE_URL: PLAIN });
    expect(config.neonAuthBaseUrl).toBe(PLAIN);
    expect(config.neonAuthJwksUrl).toBe(`${PLAIN}/.well-known/jwks.json`);
  });

  it("falls back to the SERVERSIDE_NEON_ names the Vercel Neon integration injects", () => {
    const config = readConfig({ SERVERSIDE_NEON_NEON_AUTH_BASE_URL: `${PREFIXED}/` });
    expect(config.neonAuthBaseUrl).toBe(`${PREFIXED}/`);
    expect(config.neonAuthJwksUrl).toBe(`${PREFIXED}/.well-known/jwks.json`);
  });

  it("uses a prefixed JWKS URL only alongside the prefixed base URL", () => {
    const config = readConfig({ SERVERSIDE_NEON_NEON_AUTH_BASE_URL: PREFIXED, SERVERSIDE_NEON_NEON_AUTH_JWKS_URL: "https://keys.example/jwks" });
    expect(config.neonAuthJwksUrl).toBe("https://keys.example/jwks");
  });

  it("prefers the plain names when both are set and never mixes sources", () => {
    const config = readConfig({
      NEON_AUTH_BASE_URL: PLAIN,
      SERVERSIDE_NEON_NEON_AUTH_BASE_URL: PREFIXED,
      SERVERSIDE_NEON_NEON_AUTH_JWKS_URL: "https://keys.example/jwks",
    });
    expect(config.neonAuthBaseUrl).toBe(PLAIN);
    expect(config.neonAuthJwksUrl).toBe(`${PLAIN}/.well-known/jwks.json`);
  });

  it("treats blank values as unset", () => {
    const config = readConfig({ NEON_AUTH_BASE_URL: "  ", SERVERSIDE_NEON_NEON_AUTH_BASE_URL: PREFIXED });
    expect(config.neonAuthBaseUrl).toBe(PREFIXED);
  });

  it("ignores other Neon integrations' prefixes and stays disabled when nothing is set", () => {
    const config = readConfig({ NEON_STORE_NEON_AUTH_BASE_URL: "https://store.example/auth" });
    expect(config.neonAuthBaseUrl).toBeUndefined();
    expect(config.neonAuthJwksUrl).toBeUndefined();
  });
});
