/**
 * End-to-end check against a REAL Neon database + Neon Auth. Skipped unless these are set:
 *   TEST_DATABASE_URL        connection string of a THROWAWAY Neon branch (the test writes and deletes rows)
 *   TEST_NEON_AUTH_BASE_URL  Neon Auth base URL of that same branch
 * Run: TEST_DATABASE_URL=... TEST_NEON_AUTH_BASE_URL=... npm test
 *
 * All aircraft written here are conspicuously-labelled SYNTHETIC TEST VECTORS (provider "synthetic-test-vector",
 * ICAO24 prefix fffe) that exist only inside this test and are deleted afterwards. They are never real or mock
 * observations shown by the app (see AGENTS.md).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aircraftSearchResponseSchema, nearbyAircraftResponseSchema, routeSummaryResponseSchema, trackInsightsResponseSchema, trackResponseSchema } from "../src/domain/aircraft";
import { aircraftProfileSchema } from "../src/domain/profile";
import { createApp } from "./app";
import { createJwtVerifier } from "./auth";
import { recordObservations, type RecorderObservation } from "./recorder";

const databaseUrl = process.env.TEST_DATABASE_URL;
const authUrl = process.env.TEST_NEON_AUTH_BASE_URL;
const origin = "http://localhost:5173";
const icao24 = "fffe01";
const run = Date.now().toString(36);
const sha = (label: string) => createHash("sha256").update(`${run}:${label}`).digest("hex");
const password = `Itest-${run}-Pass!`;
const emails = { granted: `itest-granted-${run}@example.com`, plain: `itest-plain-${run}@example.com` };

describe.skipIf(!databaseUrl || !authUrl)("Neon Postgres + Neon Auth (integration)", () => {
  // Created in beforeAll: describe bodies are still evaluated when the suite is skipped.
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  const node = (script: string, ...args: string[]) =>
    execFileSync(process.execPath, [script, ...args], { env: { ...process.env, DATABASE_URL: databaseUrl!, DATABASE_URL_UNPOOLED: databaseUrl! }, encoding: "utf8" });
  const call = async (path: string, token?: string) => app.request(path, { headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) } });

  async function jwtFor(email: string) {
    const headers = { "Content-Type": "application/json", Origin: origin };
    const signUp = await fetch(`${authUrl}/sign-up/email`, { method: "POST", headers, body: JSON.stringify({ name: "itest", email, password }) });
    expect(signUp.status).toBe(200);
    const signIn = await fetch(`${authUrl}/sign-in/email`, { method: "POST", headers, body: JSON.stringify({ email, password }) });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const tokenResponse = await fetch(`${authUrl}/token`, { headers: { Origin: origin, Cookie: cookie } });
    expect(tokenResponse.status).toBe(200);
    const { token } = (await tokenResponse.json()) as { token: string };
    expect(token.split(".")).toHaveLength(3);
    return token;
  }

  let observations: RecorderObservation[] = [];
  let grantedToken = "";
  let plainToken = "";

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    app = createApp({ db: pool, verifier: createJwtVerifier({ baseUrl: authUrl! }), allowedOrigins: new Set([origin]), adsbConfigured: false, historyRateLimit: 1000, profileRateLimit: 1000 });
    node("scripts/migrate.mjs");
    node("scripts/migrate.mjs"); // idempotent
    const base = Date.now() - 3 * 3_600_000;
    observations = Array.from({ length: 25 }, (_, index) => {
      const observedAt = new Date(base + index * 60_000).toISOString();
      return {
        provider: "synthetic-test-vector", providerSchemaVersion: "test-1", normalizationVersion: "test-1",
        icao24, registration: "N99ZZ", callsign: "SYNTH01",
        latitude: 39.7684 + index * 0.001, longitude: -86.1581, altitudeFt: 3000 + index * 10, altitudeSource: "barometric",
        groundSpeedKt: 120 + index, trackDeg: 90, verticalRateFpm: 0, onGround: false,
        observedAt, receivedAt: observedAt, raw: { synthetic: true },
      };
    });
    const recorded = await recordObservations(pool, observations);
    expect(recorded).toEqual({ received: 25, inserted: 25, duplicate: 0, rejected: 0 });
    // FAA registry fixture so the profile route exercises its joins.
    const { rows: [importRun] } = await pool.query<{ id: string }>(
      "insert into airintel_private.faa_import_runs (source_url, source_filename, source_sha256, snapshot_date, importer_version, schema_version, status) values ('https://www.faa.gov/synthetic-test-vector', 'synthetic.txt', $1, '2026-01-01', 'test', 'test', 'published') returning id",
      [sha("import")],
    );
    const { rows: [registry] } = await pool.query<{ id: string }>(
      "insert into public.aircraft_registry_records (import_run_id, snapshot_date, registry_unique_id, n_number, mode_s_hex, manufacturer_name, model_name, owner_visibility, source_row_hash) values ($1, '2026-01-01', $2, 'N99ZZ', $3, 'SYNTHETIC MFR', 'SYNTHETIC MODEL', 'withheld', $4) returning id",
      [importRun!.id, `itest-${run}`, icao24, sha("row")],
    );
    await pool.query("insert into public.aircraft_registry_matches (aircraft_id, registry_record_id, match_status, match_method, matcher_version) select a.id, $1, 'confirmed', 'mode_s_hex_exact', 'test' from public.aircraft a where a.icao24 = $2", [registry!.id, icao24]);

    grantedToken = await jwtFor(emails.granted);
    plainToken = await jwtFor(emails.plain);
    node("scripts/access.mjs", "grant", "--email", emails.granted, "--scope", "history,profile");
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query("delete from public.aircraft where icao24 = $1", [icao24]).catch(() => undefined);
    await pool.query("delete from airintel_private.faa_import_runs where source_url = 'https://www.faa.gov/synthetic-test-vector'").catch(() => undefined);
    await pool.query("delete from public.aircraft_registry_records where registry_unique_id = $1", [`itest-${run}`]).catch(() => undefined);
    await pool.query("delete from public.data_sources where key = 'synthetic-test-vector'").catch(() => undefined);
    await pool.query(`delete from airintel_private.access_grants where user_id in (select id from neon_auth."user" where email = any($1))`, [Object.values(emails)]).catch(() => undefined);
    await pool.query(`delete from neon_auth."user" where email = any($1)`, [Object.values(emails)]).catch(() => undefined);
    await pool?.end();
  });

  it("rejects missing and unprivileged callers, accepts a real Neon Auth JWT with a grant", async () => {
    expect((await call("/history?action=search&q=fffe")).status).toBe(401);
    expect((await call("/history?action=search&q=fffe", "not.a.jwt")).status).toBe(401);
    const denied = await call("/history?action=search&q=fffe", plainToken);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "history_access_denied" });
    expect((await call("/aircraft-profile?icao24=fffe01", plainToken)).status).toBe(403);
    expect((await call("/history?action=search&q=fffe", grantedToken)).status).toBe(200);
  });

  it("recorder is idempotent: replaying recorded observations inserts nothing", async () => {
    expect(await recordObservations(pool, observations.slice(0, 5))).toEqual({ received: 5, inserted: 0, duplicate: 5, rejected: 0 });
    const { rows } = await pool.query("select count(*)::int as n from public.aircraft_positions p join public.aircraft a on a.id = p.aircraft_id where a.icao24 = $1", [icao24]);
    expect(rows[0]).toEqual({ n: 25 });
  });

  it("search finds the aircraft by ICAO24, registration, callsign prefix, and matches the browser schema", async () => {
    for (const q of ["fffe0", "N99ZZ", "n99", "SYNTH"]) {
      const response = await call(`/history?action=search&q=${q}`, grantedToken);
      expect(response.status).toBe(200);
      const parsed = aircraftSearchResponseSchema.parse(await response.json());
      expect(parsed.aircraft.map((item) => item.icao24)).toContain(icao24);
    }
  });

  it("track, insights, route-summary and nearby match the browser schemas", async () => {
    const track = trackResponseSchema.parse(await (await call(`/history?action=track&icao24=${icao24}&hours=24`, grantedToken)).json());
    expect(track.points).toHaveLength(25);
    expect(track.points[0]!.provider).toBe("synthetic-test-vector");
    expect(Date.parse(track.points[0]!.observedAt)).toBeLessThan(Date.parse(track.points[24]!.observedAt));
    const insights = trackInsightsResponseSchema.parse(await (await call(`/history?action=insights&icao24=${icao24}&hours=24`, grantedToken)).json());
    expect(insights.summary.pointCount).toBe(25);
    expect(insights.summary.sourceCount).toBe(1);
    const route = routeSummaryResponseSchema.parse(await (await call(`/history?action=route-summary&icao24=${icao24}&hours=24`, grantedToken)).json());
    expect(route.summary.totalDistanceNm).toBeGreaterThan(0);
    const nearby = nearbyAircraftResponseSchema.parse(await (await call("/history?action=nearby&lat=39.7684&lon=-86.1581&radiusNm=20&hours=24", grantedToken)).json());
    expect(nearby.matches.some((item) => item.icao24 === icao24)).toBe(true);
    expect((await call("/history?action=track&icao24=fffe99", grantedToken)).status).toBe(404);
  });

  it("profile joins the registry match and computes per-source statistics", async () => {
    const response = await call(`/aircraft-profile?icao24=${icao24}`, grantedToken);
    expect(response.status).toBe(200);
    const profile = aircraftProfileSchema.parse(await response.json());
    expect(profile.registryMatch.status).toBe("confirmed");
    expect(profile.registryMatch.manufacturer.value).toBe("SYNTHETIC MFR");
    expect(profile.registryMatch.registeredOwner.value).toBeNull();
    expect(profile.statisticsBySource).toHaveLength(1);
    expect(profile.statisticsBySource[0]!.validObservationCount).toBe(25);
    expect(profile.statisticsBySource[0]!.medianAltitudeFt).not.toBeNull();
  });

  it("keeps browser-facing roles locked out of every AIRIntel table", async () => {
    const { rows } = await pool.query<{ role: string; table: string }>(
      `select r.rolname as role, t.table_schema || '.' || t.table_name as "table"
         from pg_roles r cross join information_schema.tables t
        where r.rolname in ('anon', 'anonymous', 'authenticated') and t.table_schema in ('public', 'airintel_private')
          and has_table_privilege(r.rolname, quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'select')`,
    );
    expect(rows).toEqual([]);
  });
});
