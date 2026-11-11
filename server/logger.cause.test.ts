import { describe, expect, it } from "vitest";
import { errorFields } from "./logger.js";

describe("errorFields cause", () => {
  it("adds the transport cause code (undici) so 'fetch failed' is diagnosable", () => {
    const error = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Connect Timeout Error (attempted address: api.adsb.lol:443)"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
    expect(errorFields(error)).toEqual({ errorName: "TypeError", errorMessage: "fetch failed", errorCause: "UND_ERR_CONNECT_TIMEOUT" });
  });
  it("ignores causes without a safe code", () => {
    expect(errorFields(Object.assign(new Error("x"), { cause: { code: "has spaces and secrets" } }))).toEqual({ errorName: "Error", errorMessage: "x" });
  });
});
