import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { RateLimiter, type TokenVerifier } from "./auth.js";
import type { Queryable } from "./db.js";
import { recordLiveObservations, toRecorderObservations } from "./live-recording.js";
import type { LiveAircraftResult } from "./providers/adsb.js";

// TEST FIXTURES ONLY. Synthetic, conspicuously labeled values used to exercise validation and visit counting;
// they are never shipped in the app and are not presented as real-world observations.
const origin = "http://localhost:5173";
const authed = { authorization: "Bearer good" };
const userId = "860dc360-609f-4b7d-9e70-ec93fe6414d3";
const verifier: TokenVerifier = async (token) => (token === "good" ? { id: userId, email: "pilot@example.com" } : null);

type Answer = (text: string, params?: readonly unknown[]) => unknown[] | undefined;
function fakeDb(grants: string[], answer: Answer = () => undefined): Queryable & { sql: string[]; params: (readonly unknown[] | undefined)[] } {
  const sql: string[] = [];
  const params: (readonly unknown[] | undefined)[] = [];
  return {
    sql,
    params,
    query: async (text: string, values?: readonly unknown[]) => {
      sql.push(text);
      params.push(values);
      if (text.includes("access_grants")) return { rows: [{ allowed: grants.includes(String(values?.[1])) }] } as never;
      return { rows: answer(text, values) ?? [] } as never;
    },
  };
}
const build = (db: Queryable | null = fakeDb(["history", "profile"])) => createApp({ db, verifier, allowedOrigins: new Set([origin]), adsb: null });
const get = (app: ReturnType<typeof createApp>, path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { origin, ...headers } });

describe("GET /history?action=netted", () => {
  it("is protected by the same JWT + history grant as the other history routes", async () => {
    expect((await get(build(), "/history?action=netted&lat=39.7&lon=-86.1")).status).toBe(401);
    const denied = await get(build(fakeDb(["profile"])), "/history?action=netted&lat=39.7&lon=-86.1", authed);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "history_access_denied" });
    expect((await get(build(null), "/history?action=netted&lat=39.7&lon=-86.1", authed)).status).toBe(503);
  });

  it.each([
    "/history?action=netted",
    "/history?action=netted&lat=&lon=",
    "/history?action=netted&lat=91&lon=0",
    "/history?action=netted&lat=39&lon=-186",
    "/history?action=netted&lat=39&lon=-86&radiusMi=0",
    "/history?action=netted&lat=39&lon=-86&radiusMi=500",
    "/history?action=netted&lat=39&lon=-86&hours=1000",
    "/history?action=netted&lat=abc&lon=-86",
  ])("%s -> 400 invalid_netted_query", async (path) => {
    const response = await get(build(), path, authed);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_netted_query" });
  });

  it("returns an honest empty list with the 7 mile default when nothing has been recorded", async () => {
    const response = await get(build(), "/history?action=netted&lat=39.7684&lon=-86.1581", authed);
    expect(response.status).toBe(200);
    const body = await response.json() as { aircraft: unknown[]; query: { radiusMi: number; radiusNm: number; hours: number; visitGapMinutes: number }; algorithmVersion: string };
    expect(body.aircraft).toEqual([]);
    expect(body.query).toMatchObject({ radiusMi: 7, hours: 24, visitGapMinutes: 10 });
    expect(body.query.radiusNm).toBeCloseTo(6.0828, 4);
    expect(body.algorithmVersion).toBe("netted-visits-v1");
  });

  it("counts visits from recorded rows and attaches the provider type code", async () => {
    const minute = (value: number) => new Date(Date.now() - (60 - value) * 60_000);
    const row = (value: number, latitude: number) => ({ icao24: "abc123", registration: "N1TEST", callsign: "TEST1", observation_registration: null, latitude, longitude: -86, observed_at: minute(value) });
    const db = fakeDb(["history"], (text) => {
      if (text.includes("with center")) return [row(0, 40.01), row(1, 40.3), row(3, 40.02), row(20, 40.02)];
      if (text.includes("raw_observations")) return [{ icao24: "abc123", type_code: "C172" }];
      return undefined;
    });
    const response = await get(build(db), "/history?action=netted&lat=40&lon=-86&radiusMi=7&hours=2", authed);
    expect(response.status).toBe(200);
    const body = await response.json() as { aircraft: Array<Record<string, unknown>> };
    expect(body.aircraft).toHaveLength(1);
    expect(body.aircraft[0]).toMatchObject({ icao24: "abc123", callsign: "TEST1", registration: "N1TEST", aircraftTypeCode: "C172", visitCount: 3 });
    const spatialParams = db.params[db.sql.findIndex((text) => text.includes("with center"))]!;
    expect(spatialParams[0]).toBe(40);
    expect(spatialParams[1]).toBe(-86);
    expect(spatialParams[2] as number).toBeCloseTo(7 * 1609.344 * 1.01, 3);
  });
});

const liveResult = (): LiveAircraftResult => {
  const observedAt = new Date(Date.now() - 2_000).toISOString();
  const receivedAt = new Date().toISOString();
  return {
    observations: [{
      provider: "adsb_lol", providerRecordId: `abc123:${observedAt}`, icao24: "abc123", registration: null, callsign: "TEST1", latitude: 40, longitude: -86,
      geometricAltitudeFt: 4200, barometricAltitudeFt: null, altitudeFt: 4200, altitudeSource: "geometric", groundSpeedKt: 100, trackDeg: 90,
      verticalRateFpm: null, squawk: null, onGround: null, emergencyStatus: null, aircraftTypeCode: null, category: null, observedAt, receivedAt,
    }],
    receivedAt,
    sources: ["adsb_lol"],
    rawByRecordId: new Map([[`abc123:${observedAt}`, { hex: "abc123", synthetic_test_fixture: true }]]),
  };
};

describe("live view -> flight recorder contribution", () => {
  const deps = (db: Queryable | null) => ({ db, verifier, limiter: new RateLimiter(5) });

  it("never writes for anonymous or unverified callers", async () => {
    const db = fakeDb(["history"]);
    expect((await recordLiveObservations(deps(db), undefined, 6, liveResult())).status).toBe("not_signed_in");
    expect((await recordLiveObservations(deps(db), "Bearer bad", 6, liveResult())).status).toBe("not_signed_in");
    expect(db.sql.some((text) => text.includes("record_aircraft_observation"))).toBe(false);
  });

  it("requires the history grant and a bounded radius", async () => {
    expect((await recordLiveObservations(deps(fakeDb(["profile"])), "Bearer good", 6, liveResult())).status).toBe("no_history_access");
    expect((await recordLiveObservations(deps(fakeDb(["history"])), "Bearer good", 80, liveResult())).status).toBe("radius_too_large");
    expect((await recordLiveObservations(deps(null), "Bearer good", 6, liveResult())).status).toBe("unavailable");
  });

  it("writes real provider observations through the existing recorder function with the raw row", async () => {
    const db = fakeDb(["history"], (text) => (text.includes("record_aircraft_observation") ? [{ inserted: true }] : undefined));
    const outcome = await recordLiveObservations(deps(db), "Bearer good", 6, liveResult());
    expect(outcome).toMatchObject({ status: "recorded", result: { received: 1, inserted: 1, rejected: 0 } });
    const index = db.sql.findIndex((text) => text.includes("record_aircraft_observation"));
    const payload = JSON.parse(String(db.params[index]![0])) as Record<string, unknown>;
    expect(payload).toMatchObject({ provider: "adsb_lol", providerSchemaVersion: "adsb_lol/v2", icao24: "abc123", raw: { hex: "abc123" } });
  });

  it("drops observations whose raw provider row is not available instead of inventing one", () => {
    const result = liveResult();
    expect(toRecorderObservations({ ...result, rawByRecordId: new Map() })).toEqual([]);
  });

  it("does not leak raw provider rows in the public gateway response and reports the recording state", async () => {
    // Synthetic test-only upstream payload (stubbed fetch); no network access, never shipped.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ now: Date.now(), ac: [{ hex: "abc123", lat: 40, lon: -86, alt_geom: 4200, gs: 100, seen_pos: 1 }] }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const db = fakeDb(["history"], (text) => (text.includes("record_aircraft_observation") ? [{ inserted: true }] : undefined));
      const app = createApp({ db, verifier, allowedOrigins: new Set([origin]), adsb: { provider: "adsb_lol", baseUrl: "https://example.test" } });
      const anonymous = await app.request("/aircraft-nearby?lat=40&lon=-86&radiusNm=6", { headers: { origin } });
      const anonymousBody = await anonymous.json() as Record<string, unknown>;
      expect(Object.keys(anonymousBody).sort()).toEqual(["observations", "receivedAt", "recording", "sources"]);
      expect(anonymousBody.recording).toBe("not_signed_in");
      expect(db.sql.some((text) => text.includes("record_aircraft_observation"))).toBe(false);
      const signedIn = await app.request("/aircraft-nearby?lat=40&lon=-86&radiusNm=6", { headers: { origin, ...authed } });
      expect((await signedIn.json() as Record<string, unknown>).recording).toBe("recorded");
      expect(db.sql.some((text) => text.includes("record_aircraft_observation"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
