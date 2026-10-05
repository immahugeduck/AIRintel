import { describe, expect, it, vi } from "vitest";
import { fetchLiveAircraft, normalizeAdsbLolAircraft, resolveAdsbConfig } from "./adsb.js";

describe("resolveAdsbConfig", () => {
  it("defaults to adsb.lol without an API key", () => {
    expect(resolveAdsbConfig({})).toEqual({
      provider: "adsb_lol",
      baseUrl: "https://api.adsb.lol",
    });
    expect(resolveAdsbConfig({ ADSB_PROVIDER: "adsb_lol" })).toEqual({
      provider: "adsb_lol",
      baseUrl: "https://api.adsb.lol",
    });
  });

  it("can be disabled explicitly", () => {
    expect(resolveAdsbConfig({ ADSB_PROVIDER: "off" })).toBeNull();
  });

  it("requires base URL + key for unknown providers", () => {
    expect(resolveAdsbConfig({ ADSB_PROVIDER: "exchange" })).toBeNull();
    expect(
      resolveAdsbConfig({ ADSB_PROVIDER: "exchange", ADSB_API_BASE_URL: "https://example.test", ADSB_API_KEY: "secret" }),
    ).toEqual({ provider: "exchange", baseUrl: "https://example.test", apiKey: "secret" });
  });
});

describe("normalizeAdsbLolAircraft", () => {
  it("maps readsb fields with altitude provenance", () => {
    const observation = normalizeAdsbLolAircraft(
      {
        hex: "A2496B",
        lat: 39.7,
        lon: -86.5,
        alt_baro: 5200,
        alt_geom: 5450,
        gs: 95.2,
        track: 31.69,
        geom_rate: 0,
        flight: "N24652  ",
        r: "N24652",
        t: "BE23",
        seen_pos: 2,
        emergency: "none",
      },
      Date.parse("2026-10-05T20:00:00.000Z"),
      Date.parse("2026-10-05T20:00:00.000Z"),
    );
    expect(observation).toMatchObject({
      provider: "adsb_lol",
      icao24: "a2496b",
      registration: "N24652",
      callsign: "N24652",
      altitudeFt: 5450,
      altitudeSource: "geometric",
      barometricAltitudeFt: 5200,
      geometricAltitudeFt: 5450,
      observedAt: "2026-10-05T19:59:58.000Z",
    });
  });

  it("treats alt_baro ground as on-ground barometric zero", () => {
    const observation = normalizeAdsbLolAircraft(
      { hex: "abcdef", lat: 1, lon: 2, alt_baro: "ground", seen: 0 },
      Date.parse("2026-10-05T20:00:00.000Z"),
      Date.parse("2026-10-05T20:00:00.000Z"),
    );
    expect(observation).toMatchObject({
      onGround: true,
      altitudeFt: 0,
      altitudeSource: "barometric",
      barometricAltitudeFt: 0,
    });
  });

  it("drops rows without a usable ICAO24 or position", () => {
    expect(normalizeAdsbLolAircraft({ hex: "zzzzzz", lat: 1, lon: 2 }, Date.now())).toBeNull();
    expect(normalizeAdsbLolAircraft({ hex: "abcdef" }, Date.now())).toBeNull();
  });
});

describe("fetchLiveAircraft", () => {
  it("fetches and normalizes an adsb.lol radius response", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      Response.json({
        now: Date.parse("2026-10-05T20:00:00.000Z"),
        ac: [{ hex: "abcdef", lat: 39.76, lon: -86.15, alt_geom: 3000, gs: 120, track: 90, seen_pos: 1 }],
      }),
    );
    const result = await fetchLiveAircraft(
      { provider: "adsb_lol", baseUrl: "https://api.adsb.lol" },
      { lat: 39.76, lon: -86.15, radiusNm: 20 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calledUrl = fetchImpl.mock.calls[0]?.[0];
    expect(String(calledUrl)).toContain("/v2/lat/39.76/lon/-86.15/dist/20");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ "User-Agent": expect.stringContaining("AIRIntel/") }),
    });
    expect(result.sources).toEqual(["adsb_lol"]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ icao24: "abcdef", altitudeFt: 3000, altitudeSource: "geometric" });
  });

  it("keeps unknown providers unimplemented", async () => {
    await expect(
      fetchLiveAircraft({ provider: "exchange", baseUrl: "https://example.test", apiKey: "x" }, { lat: 1, lon: 2, radiusNm: 5 }),
    ).rejects.toMatchObject({ code: "provider_adapter_not_implemented" });
  });
});
