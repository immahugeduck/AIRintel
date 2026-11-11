import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { setLogSink } from "../logger.js";
import { resetProviderThrottle } from "../providers/adsb.js";

// TEST FIXTURES ONLY: synthetic hex codes, hosts and coordinates.
const origin = "http://localhost:5173";
const NOW_MS = Date.parse("2026-11-11T20:00:00.000Z");
const adsb = { provider: "adsb_lol", baseUrl: "https://lol.test", fallbacks: [{ provider: "adsb_fi" as const, baseUrl: "https://fi.test/api" }, { provider: "airplanes_live" as const, baseUrl: "https://live.test" }] };
const body = (hex: string) => JSON.stringify({ now: NOW_MS, ac: [{ hex, lat: 39.7, lon: -86.1, alt_geom: 4000, seen_pos: 1 }] });
const connectTimeout = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
const build = () => createApp({ db: null, verifier: null, allowedOrigins: new Set([origin]), adsb });
const get = (path: string) => build().request(path, { headers: { origin } });

afterEach(() => { vi.unstubAllGlobals(); resetProviderThrottle(); });

describe("GET /aircraft-nearby provider fallback", () => {
  it("serves adsb.fi aircraft when adsb.lol is unreachable and says which provider served", async () => {
    const restore = setLogSink(() => undefined);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (new URL(String(input)).host === "lol.test") throw connectTimeout();
      return new Response(body("bbb222"));
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await get("/aircraft-nearby?lat=39.77&lon=-86.16&radiusNm=25");
      expect(response.status).toBe(200);
      const json = await response.json() as Record<string, unknown>;
      expect(json).toMatchObject({ sources: ["adsb_fi"], providerFailures: [{ provider: "adsb_lol", code: "provider_network_error", detail: "UND_ERR_CONNECT_TIMEOUT" }], observations: [{ provider: "adsb_fi", icao24: "bbb222" }] });
      // adsb.lol is not retried when fallbacks exist: one attempt, then adsb.fi.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { restore(); }
  });

  it("omits providerFailures when adsb.lol answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body("aaa111"))));
    const json = await (await get("/aircraft-nearby?lat=39.77&lon=-86.16&radiusNm=25")).json() as Record<string, unknown>;
    expect(json.sources).toEqual(["adsb_lol"]);
    expect(json).not.toHaveProperty("providerFailures");
  });

  it("still answers 502 provider_upstream_failed when all fail, and logs each provider's failure", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      if (new URL(String(input)).host === "lol.test") throw connectTimeout();
      return new Response("no", { status: 503 });
    }));
    try {
      const response = await get("/aircraft-nearby?lat=39.77&lon=-86.16&radiusNm=25");
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "provider_upstream_failed" });
      const entry = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((e) => e.event === "aircraft_provider_failed");
      expect(entry).toMatchObject({ code: "provider_network_error", errorMessage: "all_providers_failed adsb_lol=provider_network_error(UND_ERR_CONNECT_TIMEOUT); adsb_fi=provider_upstream_failed(503); airplanes_live=provider_upstream_failed(503)" });
    } finally { restore(); }
  });

  it("lists the provider order on /health", async () => {
    const json = await (await build().request("/health")).json() as Record<string, unknown>;
    expect(json).toMatchObject({ provider: true, providers: ["adsb_lol", "adsb_fi", "airplanes_live"] });
  });
});
