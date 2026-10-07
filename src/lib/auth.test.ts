import { describe, expect, it } from "vitest";
import { getAccessToken, getAuthClient } from "./auth";

describe("Neon Auth browser client", () => {
  it("is not created and yields no token when VITE_NEON_AUTH_URL is unset", async () => {
    expect(getAuthClient()).toBeNull();
    expect(await getAccessToken()).toBeNull();
  });
});
