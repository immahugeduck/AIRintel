import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { TokenVerifier } from "./auth.js";
import type { Queryable } from "./db.js";

const origin = "http://localhost:5173";
const authed = { authorization: "Bearer good" };
const userId = "860dc360-609f-4b7d-9e70-ec93fe6414d3";
const verifier: TokenVerifier = async (token) => (token === "good" ? { id: userId, email: "pilot@example.com" } : null);

/** Records SQL and answers the grant lookup; every other query returns no rows. */
function fakeDb(grants: string[]): Queryable & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    query: async (text: string, params?: readonly unknown[]) => {
      sql.push(text);
      if (text.includes("access_grants")) return { rows: [{ allowed: grants.includes(String(params?.[1])) }] } as never;
      return { rows: [] } as never;
    },
  };
}

const build = (overrides: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({ db: fakeDb(["history", "profile"]), verifier, allowedOrigins: new Set([origin]), adsb: null, ...overrides });
const get = (app: ReturnType<typeof createApp>, path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { origin, ...headers } });

describe("origin and method guard", () => {
  it("rejects requests from origins that are not allow-listed", async () => {
    const response = await build().request("/history?action=search&q=N123", { headers: { origin: "https://evil.example.com", ...authed } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    expect((await build().request("/history")).status).toBe(403);
  });

  it("answers CORS preflight for an allowed origin and echoes only that origin", async () => {
    const response = await build().request("/history", { method: "OPTIONS", headers: { origin } });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("accepts same-origin GETs that carry no Origin header (SPA + API on one Vercel project)", async () => {
    const app = build();
    const sameOrigin = await app.request("/history?action=bogus", { headers: { "sec-fetch-site": "same-origin", ...authed } });
    expect(sameOrigin.status).toBe(400); // passed the guard, auth and grant, failed validation
    expect((await app.request("/history?action=bogus", { headers: { "sec-fetch-site": "cross-site", ...authed } })).status).toBe(403);
    expect((await app.request("/history?action=bogus", { headers: authed })).status).toBe(403);
  });

  it("only allows GET", async () => {
    expect((await build().request("/history", { method: "POST", headers: { origin, ...authed } })).status).toBe(405);
  });
});

describe("authentication and authorization (Neon Auth JWT + access grants)", () => {
  it("requires a Bearer token", async () => {
    expect((await get(build(), "/history?action=search&q=N123")).status).toBe(401);
    expect((await get(build(), "/history?action=search&q=N123", { authorization: "Bearer bad" })).status).toBe(401);
  });

  it("denies a verified user who has no grant for the route", async () => {
    const app = build({ db: fakeDb(["profile"]) });
    const response = await get(app, "/history?action=search&q=N123", authed);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "history_access_denied" });
    expect((await get(build({ db: fakeDb(["history"]) }), "/aircraft-profile?icao24=abcdef", authed)).status).toBe(403);
  });

  it("reports database_not_configured when Neon is not wired up", async () => {
    const response = await get(build({ db: null, verifier: null }), "/history?action=search&q=N123", authed);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "database_not_configured" });
  });

  it("rate limits each user", async () => {
    const app = build({ historyRateLimit: 2 });
    expect((await get(app, "/history?action=bogus", authed)).status).toBe(400);
    expect((await get(app, "/history?action=bogus", authed)).status).toBe(400);
    const limited = await get(app, "/history?action=bogus", authed);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
  });

  it("does not send any SQL for an unauthenticated request", async () => {
    const db = fakeDb(["history"]);
    await get(build({ db }), "/history?action=search&q=N123");
    expect(db.sql).toHaveLength(0);
  });
});

describe("history input validation", () => {
  it.each([
    ["/history?action=search&q=a", "invalid_search"],
    ["/history?action=search&q=N1%25", "invalid_search"],
    ["/history?action=track&icao24=zzzzzz", "invalid_track_query"],
    ["/history?action=nearby&lat=abc&lon=1", "invalid_spatial_query"],
    ["/history?action=other", "invalid_action"],
  ])("%s -> 400 %s", async (path, error) => {
    const response = await get(build(), path, authed);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  });

  it("returns 404 for an aircraft that was never recorded and an empty search list", async () => {
    expect((await get(build(), "/history?action=track&icao24=abcdef", authed)).status).toBe(404);
    const search = await get(build(), "/history?action=search&q=N123", authed);
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({ aircraft: [] });
  });

  it("validates the profile ICAO24", async () => {
    expect((await get(build(), "/aircraft-profile?icao24=nope", authed)).status).toBe(400);
  });
});

describe("public gateways", () => {
  it("serves /health without an origin", async () => {
    const response = await build().request("/health");
    expect(await response.json()).toEqual({ ok: true, database: true, auth: true });
  });

  it("keeps the aircraft provider gated until configured", async () => {
    expect((await get(build(), "/aircraft-nearby?lat=1&lon=1&radiusNm=0")).status).toBe(400);
    expect((await get(build(), "/aircraft-nearby?lat=39&lon=-86&radiusNm=20")).status).toBe(503);
    expect((await get(build({ adsb: { provider: "exchange", baseUrl: "https://example.test", apiKey: "x" } }), "/aircraft-nearby?lat=39&lon=-86&radiusNm=20")).status).toBe(501);
  });

  it("validates satellite queries before touching CelesTrak", async () => {
    expect((await get(build(), "/satellites-nearby?lat=100&lon=0")).status).toBe(400);
    expect((await get(build(), "/satellites-nearby?lat=1&lon=1&groups=NOPE")).status).toBe(400);
    expect((await get(build(), "/satellite-passes?lat=1&lon=1&hours=999")).status).toBe(400);
    expect((await get(build(), "/satellite-passes?lat=1&lon=1&start=2001-01-01T00:00:00Z")).status).toBe(400);
  });
});
