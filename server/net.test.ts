import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { TokenVerifier } from "./auth.js";
import { readConfig, type NetConfig } from "./config.js";
import type { Queryable } from "./db.js";
import { setLogSink } from "./logger.js";
import { PROVIDER_TIMEOUT_MS, SWEEP_LEASE_SECONDS, planSweep, providerAttemptOptions, runSweep, fetchRadiusNm } from "./net-sweep.js";
import { recordObservations } from "./recorder.js";
import { secretsMatch } from "./routes/net.js";
import { distanceNm } from "../src/domain/geometry.js";
import { milesToNm } from "../src/domain/units.js";

// TEST FIXTURES ONLY. The provider payloads, coordinates and database below are synthetic, conspicuously labelled
// stubs that exist solely inside this test file; nothing here is shipped or presented as a real observation.
const origin = "http://localhost:5173";
const SECRET = "test-fixture-cron-secret-0123456789abcdef";
const userA = "860dc360-609f-4b7d-9e70-ec93fe6414d3";
const userB = "0f6d9a54-1111-4222-8333-444455556666";
const verifier: TokenVerifier = async (token) => (token === "good" ? { id: userA, email: "a@example.com" } : token === "other" ? { id: userB, email: "b@example.com" } : null);
const NET: NetConfig = { maxAreas: 25, marginFactor: 2, minIntervalSeconds: 30, budgetMs: 40_000, retentionDays: undefined };

type AreaFixture = { user_id: string; latitude: number; longitude: number; radius_mi: number; enabled: boolean; last_polled_at: Date | null; last_success_at: Date | null; last_poll_status: string | null; created_at: Date; updated_at: Date };
const area = (user_id: string, latitude: number, longitude: number, radius_mi = 7, extra: Partial<AreaFixture> = {}): AreaFixture => ({ user_id, latitude, longitude, radius_mi, enabled: true, last_polled_at: null, last_success_at: null, last_poll_status: null, created_at: new Date(), updated_at: new Date(), ...extra });

type StubOptions = { grants?: string[]; areas?: AreaFixture[]; leaseHeld?: boolean; sweepState?: { last_finished_at: Date | null; last_status: string | null; last_purge_at: Date | null; last_purge_deleted: number | null } };
function stubDb(options: StubOptions = {}) {
  const calls: { text: string; params: readonly unknown[] | undefined }[] = [];
  const areas = new Map((options.areas ?? []).map((row) => [row.user_id, row]));
  const positions = new Set<string>();
  const state = { leaseHeld: options.leaseHeld ?? false, released: 0, polled: [] as { ids: string[]; status: string; success: boolean }[], purged: 0 };
  const db: Queryable = {
    query: async (text: string, params?: readonly unknown[]) => {
      calls.push({ text, params });
      if (text.includes("access_grants")) return { rows: [{ allowed: (options.grants ?? ["history"]).includes(String(params?.[1])) }] } as never;
      if (text.includes("set locked_until = now()")) { if (state.leaseHeld) return { rows: [] } as never; state.leaseHeld = true; return { rows: [{ id: true }] } as never; }
      if (text.includes("set locked_until = null")) { state.leaseHeld = false; state.released += 1; return { rows: [] } as never; }
      if (text.includes("from airintel_private.net_watch_areas") && text.includes("order by last_polled_at")) return { rows: [...areas.values()].filter((row) => row.enabled && row.last_polled_at === null) } as never;
      if (text.includes("update airintel_private.net_watch_areas") && text.includes("set last_polled_at")) { state.polled.push({ ids: params?.[0] as string[], status: String(params?.[1]), success: params?.[2] === true }); return { rows: [] } as never; }
      if (text.includes("insert into airintel_private.net_watch_areas")) {
        const row = area(String(params?.[0]), Number(params?.[1]), Number(params?.[2]), Number(params?.[3]), { enabled: params?.[4] === true });
        areas.set(row.user_id, row);
        return { rows: [row] } as never;
      }
      if (text.includes("from airintel_private.net_watch_areas where user_id")) return { rows: areas.has(String(params?.[0])) ? [areas.get(String(params?.[0]))] : [] } as never;
      if (text.includes("from airintel_private.net_sweep_state")) return { rows: options.sweepState ? [options.sweepState] : [] } as never;
      if (text.includes("exists (select 1 from airintel_private.net_watch_areas")) return { rows: [{ present: [...areas.values()].some((row) => row.enabled) }] } as never;
      if (text.includes("purge_aircraft_observations")) { state.purged += 1; return { rows: [{ deleted: 7 }] } as never; }
      if (text.includes("record_aircraft_observation")) {
        const input = JSON.parse(String(params?.[0])) as { dedupeKey: string; providerRecordId?: string };
        const key = input.providerRecordId ?? input.dedupeKey;
        if (positions.has(key)) return { rows: [{ inserted: false }] } as never;
        positions.add(key);
        return { rows: [{ inserted: true }] } as never;
      }
      return { rows: [] } as never;
    },
  };
  return { db, calls, state, positions, areas };
}

/** adsb.lol-shaped stub payload (TEST FIXTURE hex codes / registrations). */
const NOW = Date.parse("2026-10-11T17:00:00.000Z");
const providerPayload = (rows: Record<string, unknown>[]) => ({ now: NOW, ac: rows });
const aircraftRow = (hex: string, lat: number, lon: number, extra: Record<string, unknown> = {}) => ({ hex, lat, lon, alt_baro: 3000, gs: 120, track: 90, flight: "TEST1   ", r: "N0TEST", t: "TST1", seen_pos: 1, ...extra });
const okFetch = (rows: Record<string, unknown>[]) => vi.fn(async () => new Response(JSON.stringify(providerPayload(rows)), { status: 200 }));

const adsb = { provider: "adsb_lol", baseUrl: "https://provider.test" };
const noSleep = { sleep: async () => undefined };
vi.useFakeTimers({ toFake: ["Date"], now: NOW });
setLogSink(() => undefined); // keep test output quiet; the log test below installs its own sink

const sweepApp = (deps: { db?: Queryable | null; cronSecret?: string | undefined; fetchImpl?: typeof fetch; adsbConfig?: typeof adsb | null } = {}) =>
  createApp({ db: deps.db === undefined ? stubDb().db : deps.db, verifier, allowedOrigins: new Set([origin]), adsb: deps.adsbConfig === undefined ? adsb : deps.adsbConfig, cronSecret: "cronSecret" in deps ? deps.cronSecret : SECRET, net: NET, sweepFetch: deps.fetchImpl ?? okFetch([]), sweepProviderOptions: noSleep });

describe("sweep authentication", () => {
  it("fails closed with 503 when CRON_SECRET is unset, even for a request that sends a bearer", async () => {
    const fetchImpl = okFetch([]);
    const app = sweepApp({ cronSecret: undefined, fetchImpl });
    for (const method of ["GET", "POST"]) {
      const response = await app.request("/net/sweep", { method, headers: { authorization: "Bearer anything" } });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "sweep_not_configured" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a missing, malformed or wrong secret with 401 and never touches the provider or database", async () => {
    const stub = stubDb();
    const fetchImpl = okFetch([]);
    const app = sweepApp({ db: stub.db, fetchImpl });
    for (const headers of [{}, { authorization: "Basic abc" }, { authorization: "Bearer wrong" }, { authorization: `Bearer ${SECRET}x` }, { authorization: `Bearer ${SECRET.slice(0, -1)}` }, { authorization: SECRET }] as Record<string, string>[]) {
      const response = await app.request("/net/sweep", { method: "POST", headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stub.calls).toHaveLength(0);
  });

  it("accepts the right secret on GET (Vercel Cron) and POST (GitHub Actions) and does not require a browser origin", async () => {
    const app = sweepApp();
    for (const method of ["GET", "POST"]) {
      const response = await app.request("/net/sweep", { method, headers: { authorization: `Bearer ${SECRET}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("rejects other methods and answers 503 when the database is missing", async () => {
    expect((await sweepApp().request("/net/sweep", { method: "DELETE", headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(405);
    expect((await sweepApp({ db: null }).request("/net/sweep", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(503);
  });

  it("compares secrets in constant time (hashed) and rejects unequal lengths", () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(secretsMatch("a", SECRET)).toBe(false);
    expect(secretsMatch("", SECRET)).toBe(false);
  });

  it("treats a too-short CRON_SECRET as unset and reports the problem without echoing the value", () => {
    const config = readConfig({ CRON_SECRET: "short-secret-value" });
    expect(config.cronSecret).toBeUndefined();
    const issue = config.issues.find((item) => item.variable === "CRON_SECRET");
    expect(issue?.level).toBe("error");
    expect(JSON.stringify(config.issues)).not.toContain("short-secret-value");
    expect(readConfig({ CRON_SECRET: SECRET }).cronSecret).toBe(SECRET);
  });
});

describe("config validation", () => {
  it("rejects out-of-range sweep tuning with clear messages and safe defaults", () => {
    const config = readConfig({ NET_SWEEP_MAX_AREAS: "0", NET_SWEEP_MARGIN_FACTOR: "9", NET_RETENTION_DAYS: "2", NET_SWEEP_BUDGET_MS: "abc" });
    expect(config.net).toMatchObject({ maxAreas: 25, marginFactor: 2, budgetMs: 40_000, retentionDays: undefined });
    expect(config.issues.map((issue) => issue.variable).sort()).toEqual(["DATABASE_URL", "NEON_AUTH_BASE_URL", "NET_RETENTION_DAYS", "NET_SWEEP_BUDGET_MS", "NET_SWEEP_MARGIN_FACTOR", "NET_SWEEP_MAX_AREAS"]);
  });

  it("never auto-deletes unless NET_RETENTION_DAYS is set", () => {
    expect(readConfig({}).net.retentionDays).toBeUndefined();
    expect(readConfig({ NET_RETENTION_DAYS: "90" }).net.retentionDays).toBe(90);
  });

  it("flags VITE_-prefixed secrets", () => {
    const issues = readConfig({ VITE_CRON_SECRET: "x", VITE_MAPBOX_ACCESS_TOKEN: "pk.public" }).issues;
    expect(issues.some((issue) => issue.variable === "VITE_CRON_SECRET" && issue.level === "error")).toBe(true);
    expect(issues.some((issue) => issue.variable === "VITE_MAPBOX_ACCESS_TOKEN")).toBe(false);
  });
});

describe("provider wait and sweep budget", () => {
  it("waits up to 15 s per adsb.lol attempt and retries only when two full attempts still fit", () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(15_000);
    expect(providerAttemptOptions(40_000)).toEqual({ timeoutMs: 15_000, retries: 1 });
    expect(providerAttemptOptions(31_000)).toEqual({ timeoutMs: 15_000, retries: 0 });
    expect(providerAttemptOptions(9_000)).toEqual({ timeoutMs: 9_000, retries: 0 });
    expect(providerAttemptOptions(500)).toEqual({ timeoutMs: 2_000, retries: 0 });
  });

  it("defaults to a 40 s budget that fits the 60 s function limit, and caps overrides at 45 s", async () => {
    expect(readConfig({}).net.budgetMs).toBe(40_000);
    const tooLong = readConfig({ NET_SWEEP_BUDGET_MS: "55000" });
    expect(tooLong.net.budgetMs).toBe(40_000);
    expect(tooLong.issues.map((issue) => issue.variable)).toContain("NET_SWEEP_BUDGET_MS");
    const { readFileSync } = await import("node:fs");
    const maxDuration = (JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { functions: Record<string, { maxDuration: number }> }).functions["api/index.ts"]!.maxDuration;
    // Worst case: budget + record overshoot (6 s) + slack must fit; the lease must outlive the function.
    expect(45_000 + 6_000 + 5_000).toBeLessThanOrEqual(maxDuration * 1000);
    expect(SWEEP_LEASE_SECONDS * 1000).toBeGreaterThan(maxDuration * 1000);
  });
});

describe("planSweep", () => {
  const a = { userId: "a", latitude: 40, longitude: -86, radiusMi: 7 };
  it("uses radius x margin capped at 50 NM", () => {
    expect(fetchRadiusNm(7, 2)).toBeCloseTo(milesToNm(7) * 2, 6);
    expect(fetchRadiusNm(50, 3)).toBe(50);
  });
  it("merges an area whose fetch circle lies inside an earlier query and keeps others separate", () => {
    const near = { userId: "b", latitude: 40.01, longitude: -86.01, radiusMi: 3 };
    const far = { userId: "c", latitude: 41.5, longitude: -86, radiusMi: 7 };
    const plan = planSweep([a, near, far], 2, 25);
    expect(plan.queries).toHaveLength(2);
    expect(plan.queries[0]!.members.map((member) => member.userId)).toEqual(["a", "b"]);
    expect(plan.covered).toBe(1);
    expect(distanceNm(40, -86, 41.5, -86)).toBeGreaterThan(fetchRadiusNm(7, 2));
  });
  it("defers areas beyond the per-sweep query cap", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ userId: `u${index}`, latitude: 10 + index * 2, longitude: 0, radiusMi: 7 }));
    const plan = planSweep(many, 2, 25);
    expect(plan.queries).toHaveLength(25);
    expect(plan.deferred.map((item) => item.userId)).toEqual(["u25", "u26", "u27", "u28", "u29"]);
  });
});

describe("runSweep with a stubbed provider and database", () => {
  const base = (stub: ReturnType<typeof stubDb>, fetchImpl: typeof fetch, extra: Partial<Parameters<typeof runSweep>[0]> = {}) => ({ db: stub.db, adsb, net: NET, fetchImpl, providerOptions: noSleep, ...extra });

  it("records real provider rows through the recorder with provider identity, versions and both timestamps, then marks areas polled", async () => {
    const stub = stubDb({ areas: [area(userA, 40, -86)] });
    const fetchImpl = okFetch([aircraftRow("abc123", 40.01, -86.01), aircraftRow("def456", 40.05, -86.0, { alt_baro: "ground", flight: undefined })]);
    const summary = await runSweep(base(stub, fetchImpl));
    expect(summary).toMatchObject({ ok: true, status: "completed", areas: { due: 1, queried: 1, covered: 0, deferred: 0 }, observations: { fetched: 2, inserted: 2, duplicate: 0, rejected: 0 }, errors: [] });
    const recorded = stub.calls.filter((call) => call.text.includes("record_aircraft_observation")).map((call) => JSON.parse(String(call.params?.[0])));
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ provider: "adsb_lol", providerSchemaVersion: "adsb_lol/v2", normalizationVersion: "airintel-adsb-lol-normalize-1", icao24: "abc123", raw: { hex: "abc123" } });
    expect(recorded[0].observedAt).toBe(new Date(NOW - 1000).toISOString());
    expect(recorded[0].receivedAt).toBeTruthy();
    expect(recorded[0].dedupeKey).toBe(`adsb_lol:record:abc123:${new Date(NOW - 1000).toISOString()}`);
    expect(stub.state.polled).toEqual([{ ids: [userA], status: "ok", success: true }]);
    expect(stub.state.released).toBe(1);
    // provider call: radius = 2 x 7 mi in NM, from the existing adapter URL shape
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/v2/lat/40/lon/-86/dist/");
    expect(Number(url.split("/dist/")[1])).toBeCloseTo(milesToNm(7) * 2, 6);
  });

  it("is idempotent: a repeated sweep over the same provider rows inserts nothing new", async () => {
    const stub = stubDb({ areas: [area(userA, 40, -86)] });
    const rows = [aircraftRow("abc123", 40.01, -86.01)];
    const first = await runSweep(base(stub, okFetch(rows)));
    stub.areas.get(userA)!.last_polled_at = null; // the stub's due-filter is simplified; force the area due again
    const second = await runSweep(base(stub, okFetch(rows)));
    expect(first.observations.inserted).toBe(1);
    expect(second.observations).toMatchObject({ fetched: 1, inserted: 0, duplicate: 1 });
  });

  it("skips (without polling or writing) when another sweep holds the lease", async () => {
    const stub = stubDb({ areas: [area(userA, 40, -86)], leaseHeld: true });
    const fetchImpl = okFetch([aircraftRow("abc123", 40.01, -86.01)]);
    const summary = await runSweep(base(stub, fetchImpl));
    expect(summary).toMatchObject({ ok: true, status: "skipped_locked", observations: { inserted: 0 } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stub.state.released).toBe(0); // must not release a lease it does not own
  });

  it("two overlapping sweeps launched together: exactly one runs", async () => {
    const stub = stubDb({ areas: [area(userA, 40, -86)] });
    const fetchImpl = okFetch([aircraftRow("abc123", 40.01, -86.01)]);
    const [one, two] = await Promise.all([runSweep(base(stub, fetchImpl)), runSweep(base(stub, fetchImpl))]);
    expect([one.status, two.status].sort()).toEqual(["completed", "skipped_locked"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serves two overlapping users with one provider query", async () => {
    const stub = stubDb({ areas: [area(userA, 40, -86, 7), area(userB, 40.005, -86.005, 3)] });
    const fetchImpl = okFetch([aircraftRow("abc123", 40.01, -86.01)]);
    const summary = await runSweep(base(stub, fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(summary.areas).toMatchObject({ due: 2, queried: 1, covered: 1 });
    expect(stub.state.polled[0]!.ids.sort()).toEqual([userA, userB].sort());
  });

  it("credits each area owner with their own encounters, measured against their own radius", async () => {
    const stub = stubDb({ areas: [area(userA, 40, -86, 7), area(userB, 40.005, -86.005, 3)] });
    const encounters: unknown[][] = [];
    const db: Queryable = {
      query: async (text: string, params?: readonly unknown[]) => {
        if (text.includes("insert into airintel_private.user_aircraft_tallies")) return { rows: [{ icao24: params?.[1] }] } as never;
        if (text.includes("insert into airintel_private.encounters")) { encounters.push([...(params ?? [])]); return { rows: [{ id: `enc-${encounters.length}` }] } as never; }
        return stub.db.query(text, params);
      },
    };
    // abc123 is inside both radii; def456 (~5 mi out) is inside A's 7 mi radius only.
    const summary = await runSweep({ ...base(stub, okFetch([aircraftRow("abc123", 40.01, -86.01), aircraftRow("def456", 40.07, -86.0)])), db });
    expect(summary.encounters.started).toBe(3);
    const credited = encounters.map((row) => `${String(row[0])}:${String(row[1])}:${String(row[11])}`).sort();
    expect(credited).toEqual([`${userA}:abc123:sweep`, `${userA}:def456:sweep`, `${userB}:abc123:sweep`].sort());
  });

  it("reports provider failure honestly (failed, not recorded as swept) and leaks no payloads or secrets", async () => {
    const stub = stubDb({ areas: [area(userA, 40, -86)] });
    const fetchImpl = vi.fn(async () => new Response("<html>oops secret-token-123</html>", { status: 503 }));
    const summary = await runSweep(base(stub, fetchImpl as never));
    expect(summary).toMatchObject({ ok: false, status: "failed", errors: [{ code: "provider_upstream_failed", count: 1 }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one retry for a transient 5xx
    expect(stub.state.polled).toEqual([{ ids: [userA], status: "provider_error", success: false }]);
    expect(JSON.stringify(summary)).not.toContain("secret-token");
  });

  it("returns HTTP 502 with a compact JSON summary when every area fails", async () => {
    const stub = stubDb({ areas: [area(userA, 40, -86)] });
    const response = await sweepApp({ db: stub.db, fetchImpl: vi.fn(async () => new Response("nope", { status: 500 })) as never }).request("/net/sweep", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
    expect(response.status).toBe(502);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, status: "failed" });
    expect(JSON.stringify(body)).not.toMatch(/latitude|longitude|user|nope|authorization/i);
  });

  it("never counts rows the recorder rejected as recorded: all-rejected is record_error, some-rejected is partial", async () => {
    const rows = [aircraftRow("abc123", 40.01, -86.01), aircraftRow("def456", 40.02, -86.02)];
    const allRejected = stubDb({ areas: [area(userA, 40, -86)] });
    const failed = await runSweep(base(allRejected, okFetch(rows), { record: async (_db, input) => ({ received: input.length, inserted: 0, duplicate: 0, rejected: input.length }) }));
    expect(failed).toMatchObject({ ok: false, status: "failed", observations: { fetched: 2, inserted: 0, rejected: 2 }, errors: [{ code: "record_failed", count: 1 }] });
    expect(allRejected.state.polled).toEqual([{ ids: [userA], status: "record_error", success: false }]);
    const someRejected = stubDb({ areas: [area(userA, 40, -86)] });
    const partial = await runSweep(base(someRejected, okFetch(rows), { record: async (_db, input) => ({ received: input.length, inserted: input.length - 1, duplicate: 0, rejected: 1 }) }));
    expect(partial).toMatchObject({ ok: true, status: "completed", observations: { inserted: 1, rejected: 1 } });
    expect(someRejected.state.polled).toEqual([{ ids: [userA], status: "partial", success: true }]);
  });

  it("does nothing (and says so) when no area is enabled or the provider is off", async () => {
    expect((await runSweep(base(stubDb(), okFetch([])))).status).toBe("no_areas");
    const none = await runSweep({ db: stubDb().db, adsb: null, net: NET });
    expect(none).toMatchObject({ ok: true, status: "provider_not_configured" });
  });

  it("runs the retention purge only when NET_RETENTION_DAYS is configured", async () => {
    const without = stubDb({ areas: [area(userA, 40, -86)] });
    await runSweep(base(without, okFetch([])));
    expect(without.state.purged).toBe(0);
    const withRetention = stubDb({ areas: [area(userA, 40, -86)], sweepState: { last_finished_at: null, last_status: null, last_purge_at: null, last_purge_deleted: null } });
    const summary = await runSweep(base(withRetention, okFetch([]), { net: { ...NET, retentionDays: 90 } }));
    expect(withRetention.state.purged).toBe(1);
    expect(summary.retention).toEqual({ deleted: 7 });
    const recentlyPurged = stubDb({ areas: [area(userA, 40, -86)], sweepState: { last_finished_at: null, last_status: null, last_purge_at: new Date(NOW - 60_000), last_purge_deleted: 3 } });
    await runSweep(base(recentlyPurged, okFetch([]), { net: { ...NET, retentionDays: 90 } }));
    expect(recentlyPurged.state.purged).toBe(0);
  });

  it("defers queries once the time budget is exhausted so the next sweep picks them up", async () => {
    const stub = stubDb({ areas: [area(userA, 40, -86), area(userB, 10, 10)] });
    let clock = 0;
    const fetchImpl = vi.fn(async () => { clock += 45_000; return new Response(JSON.stringify(providerPayload([])), { status: 200 }); });
    const summary = await runSweep(base(stub, fetchImpl as never, { now: () => clock }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ status: "partial", areas: { queried: 1, deferred: 1 } });
    expect(stub.state.polled).toHaveLength(1); // the deferred area is NOT marked as polled
  });
});

describe("watch-area route", () => {
  const authed = { authorization: "Bearer good", origin, "content-type": "application/json" };
  const put = (app: ReturnType<typeof sweepApp>, body: unknown, headers: Record<string, string> = authed) => app.request("/history?action=watch-area", { method: "PUT", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const valid = { latitude: 39.7684, longitude: -86.1581, radiusMi: 7, enabled: true };

  it("requires origin, a verified JWT and the history grant (GET and PUT)", async () => {
    const app = sweepApp();
    expect((await put(app, valid, { origin, "content-type": "application/json" })).status).toBe(401);
    expect((await put(app, valid, { ...authed, authorization: "Bearer nope" })).status).toBe(401);
    expect((await put(app, valid, { authorization: "Bearer good", "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    expect((await app.request("/history?action=watch-area", { headers: { origin } })).status).toBe(401);
    const noGrant = sweepApp({ db: stubDb({ grants: ["profile"] }).db });
    const denied = await put(noGrant, valid);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "history_access_denied" });
    expect((await noGrant.request("/history?action=watch-area", { headers: authed })).status).toBe(403);
    expect((await put(sweepApp({ db: null }), valid)).status).toBe(503);
  });

  it.each([
    ["not json", "{nope"],
    ["empty", ""],
    ["lat too high", { ...valid, latitude: 91 }],
    ["lon too low", { ...valid, longitude: -181 }],
    ["radius 0", { ...valid, radiusMi: 0 }],
    ["radius 51", { ...valid, radiusMi: 51 }],
    ["enabled missing", { latitude: 1, longitude: 1, radiusMi: 7 }],
    ["enabled not boolean", { ...valid, enabled: "yes" }],
    ["unknown field", { ...valid, userId: userB }],
    ["lat string", { ...valid, latitude: "39.7" }],
    ["too large", "x".repeat(2_500)],
  ])("rejects invalid input: %s", async (_name, body) => {
    const response = await put(sweepApp(), body as never);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_watch_area" });
  });

  it("saves the area for the caller only, using the JWT subject (never a body-supplied id), and reports status", async () => {
    const stub = stubDb();
    const app = sweepApp({ db: stub.db });
    const response = await put(app, valid);
    expect(response.status).toBe(200);
    const body = await response.json() as { watchArea: Record<string, unknown>; net: Record<string, unknown> };
    expect(body.watchArea).toMatchObject({ latitude: 39.7684, longitude: -86.1581, radiusMi: 7, enabled: true });
    expect(body.net).toMatchObject({ state: "pending", lastSuccessAt: null, staleAfterMinutes: 15 });
    const insert = stub.calls.find((call) => call.text.includes("insert into airintel_private.net_watch_areas"))!;
    expect(insert.params?.[0]).toBe(userA);
    expect(JSON.stringify(body)).not.toContain(userA);
    // another user sees nothing of it
    const other = await app.request("/history?action=watch-area", { headers: { ...authed, authorization: "Bearer other" } });
    expect((await other.json() as { watchArea: unknown }).watchArea).toBeNull();
    const mine = await app.request("/history?action=watch-area", { headers: authed });
    expect((await mine.json() as { watchArea: { enabled: boolean } }).watchArea.enabled).toBe(true);
  });

  it("answers GET with a paused status when nothing is saved", async () => {
    const body = await (await sweepApp().request("/history?action=watch-area", { headers: authed })).json() as { watchArea: unknown; net: { state: string } };
    expect(body).toMatchObject({ watchArea: null, net: { state: "paused" } });
  });

  it("answers 503 net_not_migrated when migration 0005 has not been applied", async () => {
    const db: Queryable = { query: async (text: string, params?: readonly unknown[]) => {
      if (text.includes("access_grants")) return { rows: [{ allowed: true }] } as never;
      void params;
      throw Object.assign(new Error('relation "airintel_private.net_watch_areas" does not exist'), { code: "42P01" });
    } };
    const app = sweepApp({ db });
    expect((await put(app, valid)).status).toBe(503);
    const get = await app.request("/history?action=watch-area", { headers: authed });
    expect(get.status).toBe(503);
    expect(await get.json()).toEqual({ error: "net_not_migrated" });
  });
});

describe("GET /health net status", () => {
  const health = async (db: Queryable | null) => (await sweepApp({ db }).request("/health")).json() as Promise<Record<string, unknown>>;
  it("reports last sweep age without secrets or user data", async () => {
    const stub = stubDb({ areas: [area(userA, 1, 1)], sweepState: { last_finished_at: new Date(NOW - 120_000), last_status: "completed", last_purge_at: null, last_purge_deleted: null } });
    const body = await health(stub.db);
    expect(body).toMatchObject({ ok: true, sweep: { secretConfigured: true }, net: { state: "ok", lastSweepAgeSeconds: 120, lastStatus: "completed" }, config: "ok" });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain(userA);
  });
  it("flags a stale sweep while areas are enabled and idle when none are", async () => {
    const old = { last_finished_at: new Date(NOW - 40 * 60_000), last_status: "completed", last_purge_at: null, last_purge_deleted: null };
    expect(((await health(stubDb({ areas: [area(userA, 1, 1)], sweepState: old }).db)).net as { state: string }).state).toBe("stale");
    expect(((await health(stubDb({ sweepState: old }).db)).net as { state: string }).state).toBe("idle");
    expect(((await health(stubDb({ areas: [area(userA, 1, 1)] }).db)).net as { state: string }).state).toBe("never");
  });
  it("degrades to unknown (still 200) when the database fails", async () => {
    const broken: Queryable = { query: async () => { throw new Error("connection refused postgres://user:pw@host/db"); } };
    const response = await sweepApp({ db: broken }).request("/health");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, net: { state: "unknown" } });
    expect(text).not.toContain("postgres://");
  });
});

describe("visit dedupe across live-view and sweep writes", () => {
  const observation = (observedAt: string, providerRecordId: string) => ({ provider: "adsb_lol", providerSchemaVersion: "adsb_lol/v2", normalizationVersion: "n1", providerRecordId, icao24: "abc123", callsign: "TEST1", altitudeFt: 3000, altitudeSource: "geometric" as const, latitude: 40.01, longitude: -86, observedAt, receivedAt: observedAt, raw: { hex: "abc123" } });

  it("writes the same provider record only once when the live view and the sweep both record it", async () => {
    const stub = stubDb();
    const record = observation("2026-10-11T16:59:00.000Z", "abc123:2026-10-11T16:59:00.000Z");
    const live = await recordObservations(stub.db, [record]);
    const sweep = await recordObservations(stub.db, [record]);
    expect(live).toMatchObject({ inserted: 1, duplicate: 0 });
    expect(sweep).toMatchObject({ inserted: 0, duplicate: 1 });
    expect(stub.positions.size).toBe(1);
    const calls = stub.calls.filter((call) => call.text.includes("record_aircraft_observation")).map((call) => JSON.parse(String(call.params?.[0])).dedupeKey);
    expect(new Set(calls).size).toBe(1);
  });
});

describe("log output", () => {
  it("emits one JSON object per line with no stack traces or secrets on a refused sweep", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    try {
      await sweepApp().request("/net/sweep", { method: "POST", headers: { authorization: "Bearer super-secret-wrong-value" } });
    } finally { restore(); }
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({ level: "warn", event: "net_sweep_refused", reason: "bad_secret" });
    expect(lines[0]).not.toContain("super-secret-wrong-value");
  });
});

describe("GET /history?action=netted visits list and net freshness", () => {
  const authed = { authorization: "Bearer good", origin };
  it("returns every entry (newest first) with timestamps and closest approach, plus the caller's net status", async () => {
    const minute = (value: number) => new Date(NOW - (120 - value) * 60_000);
    const row = (value: number, latitude: number) => ({ icao24: "abc123", registration: "N0TEST", callsign: "TEST1", observation_registration: null, latitude, longitude: -86, observed_at: minute(value) });
    const stub = stubDb({ areas: [area(userA, 40, -86, 7, { last_success_at: new Date(NOW - 3 * 60_000), last_polled_at: new Date(NOW - 3 * 60_000), last_poll_status: "ok" })] });
    const inner = stub.db.query.bind(stub.db);
    const db: Queryable = { query: async (text: string, params?: readonly unknown[]) => {
      if (text.includes("with center")) return { rows: [row(0, 40.01), row(1, 40.3), row(20, 40.02), row(21, 40.03), row(22, 40.3), row(40, 40.005)] } as never;
      if (text.includes("raw_observations")) return { rows: [{ icao24: "abc123", type_code: "TST1" }] } as never;
      return inner(text, params);
    } };
    const response = await sweepApp({ db }).request("/history?action=netted&lat=40&lon=-86&radiusMi=7&hours=3", { headers: authed });
    expect(response.status).toBe(200);
    const body = await response.json() as { aircraft: { visitCount: number; visits: { enteredAt: string; lastSeenInRadiusAt: string; closestMi: number; observationCount: number }[] }[]; net: { state: string; lastPollStatus: string } };
    const [item] = body.aircraft;
    expect(item!.visitCount).toBe(3);
    expect(item!.visits).toHaveLength(3);
    expect(item!.visits.map((visit) => visit.enteredAt)).toEqual([minute(40), minute(20), minute(0)].map((date) => date.toISOString()));
    expect(item!.visits[1]).toMatchObject({ lastSeenInRadiusAt: minute(21).toISOString(), observationCount: 2 });
    expect(item!.visits[2]!.closestMi).toBeCloseTo(0.69, 1);
    expect(body.net).toMatchObject({ state: "active", lastPollStatus: "ok" });
  });

  it("still answers when the net tables are missing (net: null)", async () => {
    const db: Queryable = { query: async (text: string) => {
      if (text.includes("access_grants")) return { rows: [{ allowed: true }] } as never;
      if (text.includes("net_watch_areas")) throw Object.assign(new Error("missing"), { code: "42P01" });
      return { rows: [] } as never;
    } };
    const response = await sweepApp({ db }).request("/history?action=netted&lat=40&lon=-86", { headers: authed });
    expect(response.status).toBe(200);
    expect((await response.json() as { net: unknown }).net).toBeNull();
  });
});
