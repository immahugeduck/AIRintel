import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderChainError,
  classifyProviderError,
  fetchLiveAircraft,
  normalizeReadsbAircraft,
  providerRecordingIdentity,
  resetProviderThrottle,
  resolveAdsbConfig,
  type AdsbProviderConfig,
} from "./adsb.js";

// TEST FIXTURES ONLY: synthetic hex codes and coordinates, no real observations.
const NOW_MS = Date.parse("2026-11-11T20:00:00.000Z");
const row = (hex: string) => ({ hex, lat: 39.7, lon: -86.1, alt_geom: 4000, gs: 110, track: 45, seen_pos: 2, r: "N0TEST", t: "TST1" });
const lolBody = () => JSON.stringify({ now: NOW_MS, ac: [row("aaa111")] });
const fiBody = () => JSON.stringify({ now: NOW_MS, ac: [row("bbb222")] }); // adsb.fi v3: ac + ms now
const fiV2Body = () => JSON.stringify({ now: NOW_MS / 1000, aircraft: [row("bbb222")] }); // deprecated v2: aircraft + seconds
const liveBody = () => JSON.stringify({ now: NOW_MS, ac: [row("ccc333")] });

const config: AdsbProviderConfig = {
  provider: "adsb_lol",
  baseUrl: "https://lol.test",
  fallbacks: [
    { provider: "adsb_fi", baseUrl: "https://fi.test/api" },
    { provider: "airplanes_live", baseUrl: "https://live.test" },
  ],
};
const query = { lat: 39.77, lon: -86.16, radiusNm: 25 };
const noSleep = { sleep: async () => undefined };
const networkError = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });

/** Routes stubbed responses by host; a host mapped to an Error throws it. */
function routedFetch(routes: Record<string, () => Response | Error>) {
  return vi.fn(async (input: string | URL) => {
    const host = new URL(String(input)).host;
    const make = routes[host];
    if (!make) throw new Error(`unexpected host ${host}`);
    const out = make();
    if (out instanceof Error) throw out;
    return out;
  });
}
const hosts = (fetchImpl: ReturnType<typeof routedFetch>) => fetchImpl.mock.calls.map((call) => new URL(String(call[0])).host);

afterEach(() => resetProviderThrottle());

describe("resolveAdsbConfig fallbacks", () => {
  it("adds adsb.fi then airplanes.live behind adsb.lol by default", () => {
    expect(resolveAdsbConfig({})?.fallbacks).toEqual([
      { provider: "adsb_fi", baseUrl: "https://opendata.adsb.fi/api" },
      { provider: "airplanes_live", baseUrl: "https://api.airplanes.live" },
    ]);
  });
  it("honours ADSB_FALLBACK_PROVIDERS order, ignores unknown names and can be turned off", () => {
    expect(resolveAdsbConfig({ ADSB_FALLBACK_PROVIDERS: "airplanes_live, bogus ,adsb_fi" })?.fallbacks?.map((f) => f.provider)).toEqual(["airplanes_live", "adsb_fi"]);
    expect(resolveAdsbConfig({ ADSB_FALLBACK_PROVIDERS: "off" })?.fallbacks).toEqual([]);
    expect(resolveAdsbConfig({ ADSB_FALLBACK_PROVIDERS: "adsb_lol,adsb_fi" })?.fallbacks?.map((f) => f.provider)).toEqual(["adsb_fi"]);
  });
});

describe("normalizeReadsbAircraft", () => {
  it("tags each observation with the provider that served it", () => {
    for (const provider of ["adsb_lol", "adsb_fi", "airplanes_live"] as const) {
      const observation = normalizeReadsbAircraft(row("abc123"), NOW_MS, NOW_MS, provider);
      expect(observation).toMatchObject({ provider, icao24: "abc123", altitudeFt: 4000, altitudeSource: "geometric", registration: "N0TEST", observedAt: "2026-11-11T19:59:58.000Z" });
    }
  });
  it("has a recorder identity per provider and keeps the adsb.lol identity unchanged", () => {
    expect(providerRecordingIdentity("adsb_lol")).toEqual({ providerSchemaVersion: "adsb_lol/v2", normalizationVersion: "airintel-adsb-lol-normalize-2" });
    expect(providerRecordingIdentity("adsb_fi")).toEqual({ providerSchemaVersion: "adsb_fi/v3", normalizationVersion: "airintel-readsb-normalize-2" });
    expect(providerRecordingIdentity("airplanes_live")).toEqual({ providerSchemaVersion: "airplanes_live/v2", normalizationVersion: "airintel-readsb-normalize-2" });
    expect(providerRecordingIdentity("exchange")).toBeNull();
  });
});

describe("fetchLiveAircraft fallback chain", () => {
  it("uses adsb.lol only when it answers", async () => {
    const fetchImpl = routedFetch({ "lol.test": () => new Response(lolBody()) });
    const result = await fetchLiveAircraft(config, query, fetchImpl as never, noSleep);
    expect(hosts(fetchImpl)).toEqual(["lol.test"]);
    expect(result.sources).toEqual(["adsb_lol"]);
    expect(result.providerFailures).toEqual([]);
  });

  it("falls back to adsb.fi (v3 URL) when adsb.lol has a network failure, and records the served provider", async () => {
    const fetchImpl = routedFetch({ "lol.test": networkError, "fi.test": () => new Response(fiBody()) });
    const result = await fetchLiveAircraft(config, query, fetchImpl as never, { ...noSleep, retries: 0 });
    expect(hosts(fetchImpl)).toEqual(["lol.test", "fi.test"]);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe("https://fi.test/api/v3/lat/39.77/lon/-86.16/dist/25");
    expect(result.sources).toEqual(["adsb_fi"]);
    expect(result.observations[0]).toMatchObject({ provider: "adsb_fi", icao24: "bbb222" });
    expect(result.rawByRecordId?.size).toBe(1);
    expect(result.providerFailures).toEqual([{ provider: "adsb_lol", code: "provider_network_error", detail: "UND_ERR_CONNECT_TIMEOUT" }]);
  });

  it("falls back to airplanes.live (/v2/point URL) after adsb.lol and adsb.fi fail", async () => {
    const fetchImpl = routedFetch({ "lol.test": () => new Response("busy", { status: 503 }), "fi.test": () => new Response("slow down", { status: 429 }), "live.test": () => new Response(liveBody()) });
    const result = await fetchLiveAircraft(config, query, fetchImpl as never, { ...noSleep, retries: 0 });
    expect(hosts(fetchImpl)).toEqual(["lol.test", "fi.test", "live.test"]);
    expect(String(fetchImpl.mock.calls[2]?.[0])).toBe("https://live.test/v2/point/39.77/-86.16/25");
    expect(result.sources).toEqual(["airplanes_live"]);
    expect(result.observations[0]).toMatchObject({ provider: "airplanes_live", icao24: "ccc333" });
    expect(result.providerFailures).toEqual([
      { provider: "adsb_lol", code: "provider_upstream_failed", detail: "503" },
      { provider: "adsb_fi", code: "provider_upstream_failed", detail: "429" },
    ]);
  });

  it("accepts the deprecated adsb.fi v2 shape (aircraft array, now in seconds)", async () => {
    const fetchImpl = routedFetch({ "lol.test": networkError, "fi.test": () => new Response(fiV2Body()) });
    const result = await fetchLiveAircraft(config, query, fetchImpl as never, { ...noSleep, retries: 0 });
    expect(result.observations[0]).toMatchObject({ provider: "adsb_fi", icao24: "bbb222", observedAt: "2026-11-11T19:59:58.000Z" });
  });

  it("falls back on an invalid adsb.lol payload", async () => {
    const fetchImpl = routedFetch({ "lol.test": () => new Response(JSON.stringify({ ac: "nope" })), "fi.test": () => new Response(fiBody()) });
    const result = await fetchLiveAircraft(config, query, fetchImpl as never, { ...noSleep, retries: 0 });
    expect(result.sources).toEqual(["adsb_fi"]);
    expect(result.providerFailures?.[0]).toMatchObject({ provider: "adsb_lol", code: "provider_invalid_payload" });
  });

  it("throws one error listing every provider's failure when all fail", async () => {
    const fetchImpl = routedFetch({ "lol.test": networkError, "fi.test": () => new Response("x", { status: 500 }), "live.test": () => new Response("{\"error\":\"contact us\"}", { status: 403 }) });
    const error = await fetchLiveAircraft(config, query, fetchImpl as never, { ...noSleep, retries: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderChainError);
    const chain = error as ProviderChainError;
    expect(chain.failures.map((f) => `${f.provider}=${f.code}:${f.detail}`)).toEqual([
      "adsb_lol=provider_network_error:UND_ERR_CONNECT_TIMEOUT",
      "adsb_fi=provider_upstream_failed:500",
      "airplanes_live=provider_upstream_failed:403",
    ]);
    expect(chain.message).toBe("all_providers_failed adsb_lol=provider_network_error(UND_ERR_CONNECT_TIMEOUT); adsb_fi=provider_upstream_failed(500); airplanes_live=provider_upstream_failed(403)");
    // Classified like the primary failure so existing sweep/route handling is unchanged.
    expect(classifyProviderError(chain)).toBe("provider_network_error");
    expect(chain.code).toBe("adsb_lol_network_error");
  });

  it("gives each fallback its own timeout and never retries a fallback", async () => {
    const seen: number[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const host = new URL(String(input)).host;
      // Record the abort deadline the provider got by observing when it fires under fake timers is overkill; check it is set.
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      seen.push(host === "lol.test" ? 0 : 1);
      if (host === "lol.test") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return new Response("x", { status: 502 });
    });
    const error = await fetchLiveAircraft(config, query, fetchImpl as never, { ...noSleep, retries: 1, fallbackTimeoutMs: 5_000 }).catch((e: unknown) => e) as ProviderChainError;
    // adsb.lol: first try + 1 retry; adsb.fi and airplanes.live: one attempt each (502 is transient but fallbacks do not retry).
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(error.failures.map((f) => f.code)).toEqual(["provider_timeout", "provider_upstream_failed", "provider_upstream_failed"]);
    expect(classifyProviderError(error)).toBe("provider_timeout");
  });

  it("stops trying fallbacks once the total budget is spent", async () => {
    let clock = NOW_MS;
    const fetchImpl = routedFetch({ "lol.test": () => { clock += 9_000; return networkError(); }, "fi.test": () => { clock += 6_000; return new Response("x", { status: 500 }); }, "live.test": () => new Response(liveBody()) });
    const error = await fetchLiveAircraft(config, query, fetchImpl as never, { ...noSleep, retries: 0, budgetMs: 16_000, now: () => clock }).catch((e: unknown) => e) as ProviderChainError;
    expect(hosts(fetchImpl)).toEqual(["lol.test", "fi.test"]);
    expect(error.failures.map((f) => `${f.provider}=${f.code}`)).toEqual(["adsb_lol=provider_network_error", "adsb_fi=provider_upstream_failed", "airplanes_live=provider_budget_exhausted"]);
  });

  it("skips providers the caller already saw fail in this run, but still tries something", async () => {
    const fetchImpl = routedFetch({ "lol.test": () => new Response(lolBody()), "fi.test": () => new Response(fiBody()) });
    const result = await fetchLiveAircraft(config, query, fetchImpl as never, { ...noSleep, skipProviders: new Set(["adsb_lol"]) });
    expect(hosts(fetchImpl)).toEqual(["fi.test"]);
    expect(result.providerFailures).toEqual([{ provider: "adsb_lol", code: "provider_skipped", detail: "failed_earlier_in_run" }]);
    // Every provider skipped: fall back to trying the primary rather than returning nothing.
    const again = await fetchLiveAircraft(config, query, fetchImpl as never, { ...noSleep, skipProviders: new Set(["adsb_lol", "adsb_fi", "airplanes_live"]) });
    expect(again.sources).toEqual(["adsb_lol"]);
  });

  it("spaces requests to the 1 request/second fallbacks", async () => {
    let clock = NOW_MS;
    const sleep = vi.fn(async (ms: number) => { clock += ms; });
    const fetchImpl = routedFetch({ "lol.test": networkError, "fi.test": () => new Response(fiBody()) });
    const options = { sleep, retries: 0, now: () => clock };
    await fetchLiveAircraft(config, query, fetchImpl as never, options);
    clock += 300;
    await fetchLiveAircraft(config, query, fetchImpl as never, options);
    expect(sleep).toHaveBeenCalledWith(700);
  });

  it("keeps the old single-provider behaviour (and error codes) when no fallbacks are configured", async () => {
    const fetchImpl = routedFetch({ "lol.test": () => new Response("no", { status: 404 }) });
    await expect(fetchLiveAircraft({ provider: "adsb_lol", baseUrl: "https://lol.test" }, query, fetchImpl as never, noSleep)).rejects.toMatchObject({ code: "adsb_lol_upstream_404" });
  });
});
