import { describe, expect, it } from "vitest";
import { normalizeSslMode } from "./db.js";

describe("normalizeSslMode", () => {
  it("pins require/prefer/verify-ca to verify-full", () => {
    expect(normalizeSslMode("postgres://u:p@h/db?sslmode=require")).toBe("postgres://u:p@h/db?sslmode=verify-full");
    expect(normalizeSslMode("postgres://u:p@h/db?sslmode=prefer&channel_binding=require")).toBe("postgres://u:p@h/db?sslmode=verify-full&channel_binding=require");
    expect(normalizeSslMode("postgres://u:p@h/db?a=1&sslmode=verify-ca")).toBe("postgres://u:p@h/db?a=1&sslmode=verify-full");
  });

  it("leaves other strings untouched", () => {
    expect(normalizeSslMode("postgres://u:p@h/db")).toBe("postgres://u:p@h/db");
    expect(normalizeSslMode("postgres://u:p@h/db?sslmode=disable")).toBe("postgres://u:p@h/db?sslmode=disable");
    expect(normalizeSslMode("postgres://u:p@h/db?uselibpqcompat=true&sslmode=require")).toBe("postgres://u:p@h/db?uselibpqcompat=true&sslmode=require");
  });
});
