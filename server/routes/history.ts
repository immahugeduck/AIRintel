import { errorFields, log } from "../logger.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { distanceNm } from "../../src/domain/geometry.js";
import { MAX_CONTROL_AREAS, controlAreaInputSchema, watchAreaInputSchema } from "../../src/domain/net.js";
import { ControlTooCloseError, deleteControlArea, listControlAreas, upsertControlArea } from "../control-areas.js";
import { MAX_VISITS_PER_AIRCRAFT, NETTED_ALGORITHM_VERSION, countRadiusVisits, nettedQuerySchema, toNettedDto, type NettedAircraft, type VisitObservation } from "../../src/domain/netted.js";
import { VISIT_GAP_MINUTES, milesToMeters, milesToNm, nmToMiles } from "../../src/domain/units.js";
import { iso, type Queryable } from "../db.js";
import type { AppVariables } from "../http.js";
import { getWatchAreaRow, toNetStatus, upsertWatchArea, watchAreaResponse } from "../net-watch.js";
import { assessLogPatterns, assessWindowPatterns, loadProviderFlags, type PatternRunStatus, type ProviderFlags } from "../patterns.js";
import { lookupRegistryIdentities } from "../registry.js";
import { geocode } from "../geocode.js";

const searchSchema = z.string().trim().min(2).max(24).regex(/^[a-zA-Z0-9-]+$/);
const icaoSchema = z.string().trim().toLowerCase().regex(/^[0-9a-f]{6}$/);
const clampHours = (raw: string | undefined, max: number) => Math.min(max, Math.max(1, Number(raw ?? 24)));

type AircraftRow = { id: string; icao24: string; registration: string | null; first_seen_at: Date; last_seen_at: Date };
const aircraftColumns = "a.id, a.icao24, a.registration, a.first_seen_at, a.last_seen_at";
const aircraftDto = (row: AircraftRow) => ({ id: row.id, icao24: row.icao24, registration: row.registration, firstSeenAt: iso(row.first_seen_at), lastSeenAt: iso(row.last_seen_at) });

async function findAircraft(db: Queryable, icao24: string) {
  const { rows } = await db.query<AircraftRow>(`select ${aircraftColumns} from public.aircraft a where a.icao24 = $1`, [icao24]);
  return rows[0] ?? null;
}

type AnalysisPosition = { source_id: string; latitude: number; longitude: number; altitude_ft: number | null; ground_speed_kt: number | null; observed_at: Date };

export function historyRoutes(db: Queryable) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/", async (c) => {
    const action = c.req.query("action");
    try {
      if (action === "search") return await search(c.req.query("q"));
      if (action === "insights") return await insights(c.req.query("icao24"), clampHours(c.req.query("hours"), 72));
      if (action === "route-summary") return await routeSummary(c.req.query("icao24"), clampHours(c.req.query("hours"), 72));
      if (action === "nearby") return await nearby(c.req.query("lat"), c.req.query("lon"), c.req.query("radiusNm"), clampHours(c.req.query("hours"), 72));
      if (action === "track") return await track(c.req.query("icao24"), clampHours(c.req.query("hours"), 24));
      if (action === "netted") return await netted();
      if (action === "watch-area") return await getWatchArea();
      if (action === "control-areas") return c.json(await listControlAreas(db, c.get("user").id));
      if (action === "geocode") return await lookupAddress(c.req.query("q"));
      return c.json({ error: "invalid_action" }, 400);
    } catch (error) {
      log("error", "history_query_failed", { action: action ?? null, ...errorFields(error) });
      const missing = (action === "watch-area" || action === "control-areas") && error && typeof error === "object" && (error as { code?: unknown }).code === "42P01";
      return c.json({ error: missing ? "net_not_migrated" : "history_query_failed" }, missing ? 503 : 500);
    }

    /** Address / place name / "lat, lon" -> one coordinate match for the location forms. */
    async function lookupAddress(raw: string | undefined) {
      const outcome = await geocode(raw);
      if (outcome.status === "found") return c.json({ result: outcome.result }, 200, { "Cache-Control": "no-store" });
      if (outcome.status === "invalid") return c.json({ error: "invalid_address" }, 400);
      if (outcome.status === "not_found") return c.json({ error: "address_not_found" }, 404);
      return c.json({ error: "geocoder_unavailable" }, 502);
    }

    /** The caller's server-side watch area (the always-on net) and its freshness. Never exposes other users' areas. */
    async function getWatchArea() {
      const row = await getWatchAreaRow(db, c.get("user").id);
      return c.json(watchAreaResponse(row));
    }

    async function search(raw: string | undefined) {
      const parsed = searchSchema.safeParse(raw);
      if (!parsed.success) return c.json({ error: "invalid_search" }, 400);
      // The pattern is restricted to [A-Za-z0-9-], so it cannot contain LIKE wildcards.
      const upperPrefix = `${parsed.data.toUpperCase()}%`;
      const lowerPrefix = `${parsed.data.toLowerCase()}%`;
      const [identity, callsign, alias] = await Promise.all([
        db.query<AircraftRow>(`select ${aircraftColumns} from public.aircraft a where a.icao24 like $1 or upper(a.registration) like $2 order by a.last_seen_at desc limit 50`, [lowerPrefix, upperPrefix]),
        db.query<AircraftRow>(`select ${aircraftColumns} from public.aircraft_positions p join public.aircraft a on a.id = p.aircraft_id where upper(p.callsign) like $1 order by p.observed_at desc limit 50`, [upperPrefix]),
        db.query<AircraftRow>(`select ${aircraftColumns} from public.aircraft_aliases al join public.aircraft a on a.id = al.aircraft_id where upper(al.alias_value) like $1 order by al.last_observed_at desc limit 50`, [upperPrefix]),
      ]);
      const matches = new Map<string, AircraftRow>();
      for (const row of [...identity.rows, ...callsign.rows, ...alias.rows]) matches.set(row.id, row);
      const aircraft = [...matches.values()].sort((a, b) => b.last_seen_at.getTime() - a.last_seen_at.getTime()).slice(0, 50).map(aircraftDto);
      return c.json({ aircraft, receivedAt: new Date().toISOString() });
    }

    async function loadWindow(rawIcao: string | undefined, hours: number) {
      const parsed = icaoSchema.safeParse(rawIcao);
      if (!parsed.success || !Number.isFinite(hours)) return { error: c.json({ error: "invalid_track_query" }, 400) } as const;
      const aircraft = await findAircraft(db, parsed.data);
      if (!aircraft) return { error: c.json({ error: "aircraft_not_found" }, 404) } as const;
      const windowEnd = new Date();
      return { aircraft, windowEnd, windowStart: new Date(windowEnd.getTime() - hours * 3_600_000) } as const;
    }

    async function insights(rawIcao: string | undefined, hours: number) {
      const window = await loadWindow(rawIcao, hours);
      if ("error" in window) return window.error;
      const { rows } = await db.query<AnalysisPosition>(
        "select source_id, latitude, longitude, altitude_ft, ground_speed_kt, observed_at from public.aircraft_positions where aircraft_id = $1 and observed_at >= $2 and observed_at <= $3 order by observed_at desc limit 10001",
        [window.aircraft.id, window.windowStart, window.windowEnd],
      );
      const stats = (values: number[]) => ({
        min: values.length > 0 ? Math.min(...values) : null,
        max: values.length > 0 ? Math.max(...values) : null,
        average: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      });
      return c.json({
        aircraft: aircraftDto(window.aircraft),
        windowStart: window.windowStart.toISOString(),
        windowEnd: window.windowEnd.toISOString(),
        receivedAt: new Date().toISOString(),
        summary: {
          pointCount: rows.length,
          sourceCount: new Set(rows.map((row) => row.source_id)).size,
          altitudeFt: stats(rows.flatMap((row) => (row.altitude_ft == null ? [] : [row.altitude_ft]))),
          groundSpeedKt: stats(rows.flatMap((row) => (row.ground_speed_kt == null ? [] : [row.ground_speed_kt]))),
        },
      });
    }

    async function routeSummary(rawIcao: string | undefined, hours: number) {
      const window = await loadWindow(rawIcao, hours);
      if ("error" in window) return window.error;
      const { rows } = await db.query<AnalysisPosition>(
        "select source_id, latitude, longitude, altitude_ft, ground_speed_kt, observed_at from public.aircraft_positions where aircraft_id = $1 and observed_at >= $2 and observed_at <= $3 order by observed_at desc limit 10001",
        [window.aircraft.id, window.windowStart, window.windowEnd],
      );
      const ordered = [...rows].reverse();
      let totalDistanceNm = 0;
      let loiteringMinutes = 0;
      let currentLoiteringMinutes = 0;
      const loiteringRadiusNm = 0.25;
      const loiteringMinMinutes = 5;
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1]!;
        const current = ordered[index]!;
        const gapMinutes = Math.max(0, (current.observed_at.getTime() - previous.observed_at.getTime()) / 60_000);
        if (previous.source_id !== current.source_id || gapMinutes > 2) { currentLoiteringMinutes = 0; continue; }
        const segmentDistanceNm = distanceNm(previous.latitude, previous.longitude, current.latitude, current.longitude);
        totalDistanceNm += segmentDistanceNm;
        if (segmentDistanceNm <= loiteringRadiusNm) {
          currentLoiteringMinutes += gapMinutes;
          if (currentLoiteringMinutes >= loiteringMinMinutes) loiteringMinutes = Math.max(loiteringMinutes, currentLoiteringMinutes);
        } else {
          currentLoiteringMinutes = 0;
        }
      }
      const speeds = ordered.flatMap((row) => (row.ground_speed_kt == null ? [] : [row.ground_speed_kt]));
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const durationMinutes = first && last && ordered.length > 1 ? Math.max(0, (last.observed_at.getTime() - first.observed_at.getTime()) / 60_000) : 0;
      return c.json({
        aircraft: aircraftDto(window.aircraft),
        windowStart: window.windowStart.toISOString(),
        windowEnd: window.windowEnd.toISOString(),
        receivedAt: new Date().toISOString(),
        summary: {
          pointCount: ordered.length,
          durationMinutes,
          totalDistanceNm,
          averageGroundSpeedKt: speeds.length > 0 ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : null,
          loiteringDetected: loiteringMinutes >= loiteringMinMinutes,
          loiteringMinutes,
        },
      });
    }

    async function nearby(rawLat: string | undefined, rawLon: string | undefined, rawRadius: string | undefined, hours: number) {
      const lat = Number(rawLat);
      const lon = Number(rawLon);
      const radiusNm = Number(rawRadius ?? 20);
      if (rawLat == null || rawLon == null || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radiusNm) || lat < -90 || lat > 90 || lon < -180 || lon > 180 || radiusNm <= 0 || radiusNm > 100 || !Number.isFinite(hours)) return c.json({ error: "invalid_spatial_query" }, 400);
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - hours * 3_600_000);
      const { rows } = await db.query<AircraftRow & { callsign: string | null; latitude: number; longitude: number; altitude_ft: number | null; ground_speed_kt: number | null; on_ground: boolean | null; observed_at: Date }>(
        `select ${aircraftColumns}, p.callsign, p.latitude, p.longitude, p.altitude_ft, p.ground_speed_kt, p.on_ground, p.observed_at
           from public.aircraft_positions p join public.aircraft a on a.id = p.aircraft_id
          where p.observed_at >= $1 and p.observed_at <= $2 order by p.observed_at desc limit 5000`,
        [windowStart, windowEnd],
      );
      const matches = rows
        .map((row) => {
          const observedDistanceNm = distanceNm(lat, lon, row.latitude, row.longitude);
          if (observedDistanceNm > radiusNm) return null;
          return { icao24: row.icao24, registration: row.registration, callsign: row.callsign ?? null, latitude: row.latitude, longitude: row.longitude, observedAt: iso(row.observed_at), distanceNm: observedDistanceNm, altitudeFt: row.altitude_ft ?? null, groundSpeedKt: row.ground_speed_kt ?? null, onGround: row.on_ground ?? null };
        })
        .filter((value): value is NonNullable<typeof value> => value != null)
        .filter((value, index, values) => values.findIndex((other) => other.icao24 === value.icao24) === index)
        .slice(0, 50);
      return c.json({ query: { latitude: lat, longitude: lon, radiusNm }, receivedAt: new Date().toISOString(), matches });
    }

    /**
     * Aircraft netted inside the watch radius with a per-aircraft visit counter computed from REAL recorded
     * observations (see countRadiusVisits in src/domain/netted.ts for the deterministic visit definition).
     * Positions inside a 3x context ring are loaded for aircraft that were ever inside, so exits are detected
     * when the recorder captured them; otherwise the reception-gap rule separates visits.
     */
    async function netted() {
      const parsed = nettedQuerySchema.safeParse({ lat: c.req.query("lat"), lon: c.req.query("lon"), radiusMi: c.req.query("radiusMi") || undefined, hours: c.req.query("hours") || undefined, scope: c.req.query("scope") || undefined });
      if (!parsed.success || !c.req.query("lat")?.trim() || !c.req.query("lon")?.trim()) return c.json({ error: "invalid_netted_query" }, 400);
      const { lat, lon, radiusMi, hours, scope } = parsed.data;
      if (scope === "log") {
        const saved = await savedLog(lat, lon, radiusMi, hours);
        if (saved) return saved;
      }
      const radiusNm = milesToNm(radiusMi);
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - hours * 3_600_000);
      const rowLimit = 50_000;
      // Geography distances are spheroidal; the 1% pad keeps boundary aircraft in the candidate set and the
      // authoritative inside/outside decision is made by countRadiusVisits with the same haversine used everywhere else.
      const { rows } = await db.query<{ icao24: string; registration: string | null; callsign: string | null; observation_registration: string | null; latitude: number; longitude: number; observed_at: Date; altitude_ft: number | null; ground_speed_kt: number | null; track_deg: number | null; vertical_rate_fpm: number | null }>(
        `with center as (select public.st_setsrid(public.st_makepoint($2::double precision, $1::double precision), 4326)::public.geography as point),
              hits as (
                select distinct p.aircraft_id from public.aircraft_positions p, center
                 where p.observed_at >= $4::timestamptz and p.observed_at <= $5::timestamptz and public.st_dwithin(p.position, center.point, $3::double precision)
              )
         select a.icao24, a.registration, p.callsign, p.observation_registration, p.latitude, p.longitude, p.observed_at,
                p.altitude_ft, p.ground_speed_kt, p.track_deg, p.vertical_rate_fpm
           from public.aircraft_positions p
           join hits h on h.aircraft_id = p.aircraft_id
           join public.aircraft a on a.id = p.aircraft_id, center
          where p.observed_at >= $4::timestamptz and p.observed_at <= $5::timestamptz and public.st_dwithin(p.position, center.point, $6::double precision)
          order by p.aircraft_id, p.observed_at
          limit ${rowLimit + 1}`,
        [lat, lon, milesToMeters(radiusMi) * 1.01, windowStart, windowEnd, milesToMeters(radiusMi) * 3],
      );
      const truncated = rows.length > rowLimit;
      const observations: VisitObservation[] = rows.slice(0, rowLimit).map((row) => ({
        icao24: row.icao24,
        observedAt: iso(row.observed_at)!,
        latitude: row.latitude,
        longitude: row.longitude,
        callsign: row.callsign,
        registration: row.observation_registration ?? row.registration,
      }));
      const summaries = countRadiusVisits(observations, { latitude: lat, longitude: lon, radiusNm, gapMinutes: VISIT_GAP_MINUTES }).slice(0, 500);
      const typeCodes = new Map<string, string>();
      if (summaries.length > 0) {
        // Provider-reported type designator (adsb.lol "t") from the latest retained raw observation; Unknown when absent.
        const types = await db.query<{ icao24: string; type_code: string | null }>(
          `select distinct on (a.icao24) a.icao24, nullif(trim(r.payload->>'t'), '') as type_code
             from public.aircraft a
             join public.aircraft_positions p on p.aircraft_id = a.id
             join airintel_private.raw_observations r on r.position_id = p.id
            where a.icao24 = any($1::text[]) and p.observed_at >= $2 and r.payload ? 't'
            order by a.icao24, p.observed_at desc`,
          [summaries.map((summary) => summary.icao24), windowStart],
        );
        for (const row of types.rows) if (row.type_code) typeCodes.set(row.icao24, row.type_code);
      }
      // Freshness of the always-on net for this user; null when the net tables are not migrated yet (never fatal).
      const net = await getWatchAreaRow(db, c.get("user").id).then((row) => toNetStatus(row), () => null);
      // Registry facts for every aircraft (owner kind for scoring); N-number / model only fill gaps in what was broadcast.
      const registry = await lookupRegistryIdentities(db, summaries.map((summary) => summary.icao24));
      const windowAircraft = summaries.map((summary) => {
        const dto = toNettedDto(summary, typeCodes.get(summary.icao24) ?? null);
        const facts = registry.get(summary.icao24);
        return { ...dto, registryRegistration: summary.registration ? null : facts?.nNumber ?? null, registryModel: dto.aircraftTypeCode ? null : facts?.model ?? null };
      });
      let patterns = new Map<string, NonNullable<NettedAircraft["pattern"]>>();
      let patternStatus: PatternRunStatus = { state: "ok", detail: null };
      try {
        const flags = await loadProviderFlags(db, windowAircraft.map((item) => item.icao24)).catch((error: unknown) => {
          log("warn", "pattern_provider_flags_failed", errorFields(error));
          patternStatus = { state: "partial", detail: "Pattern flags are incomplete: provider database flags unavailable." };
          return new Map<string, ProviderFlags>();
        });
        patterns = assessWindowPatterns(windowAircraft, rows.slice(0, rowLimit), { latitude: lat, longitude: lon }, radiusNm, { registry, flags });
      } catch (error) {
        log("error", "pattern_assessment_failed", { scope: "window", ...errorFields(error) });
        patternStatus = { state: "failed", detail: "Pattern flags could not be scored right now. The list is shown without them." };
      }
      return c.json({
        query: { latitude: lat, longitude: lon, radiusMi, radiusNm, hours, visitGapMinutes: VISIT_GAP_MINUTES },
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        receivedAt: new Date().toISOString(),
        algorithmVersion: NETTED_ALGORITHM_VERSION,
        truncated,
        aircraft: windowAircraft.map((item) => ({ ...item, pattern: patterns.get(item.icao24) ?? null })),
        net,
        source: "window",
        patternStatus,
      });
    }

    /**
     * The caller's saved encounter log (migration 0006): lifetime counts per aircraft plus the newest encounters,
     * keyed by the verified JWT subject only. Returns null (caller falls back to the window view) when the log is
     * empty or not migrated yet.
     */
    async function savedLog(lat: number, lon: number, radiusMi: number, hours: number) {
      const userId = c.get("user").id;
      const limit = 500;
      let tallies: { icao24: string; encounter_count: number; first_encountered_at: Date; last_seen_in_radius_at: Date; closest_approach_nm: number; last_callsign: string | null; last_registration: string | null }[];
      try {
        ({ rows: tallies } = await db.query(
          `select icao24, encounter_count, first_encountered_at, last_seen_in_radius_at, closest_approach_nm, last_callsign, last_registration
             from airintel_private.user_aircraft_tallies
            where user_id = $1::uuid and encounter_count > 0 and first_encountered_at is not null and last_seen_in_radius_at is not null
            order by last_seen_in_radius_at desc
            limit ${limit + 1}`,
          [userId],
        ));
      } catch (error) {
        if (error && typeof error === "object" && (error as { code?: unknown }).code === "42P01") return null;
        throw error;
      }
      if (tallies.length === 0) return null;
      const truncated = tallies.length > limit;
      const kept = tallies.slice(0, limit);
      const icaos = kept.map((row) => row.icao24);
      const [encounters, types] = await Promise.all([
        db.query<{ icao24: string; entered_at: Date; last_seen_in_radius_at: Date; closest_approach_nm: number; observation_count: number; center_latitude: number | null; center_longitude: number | null }>(
          `select icao24, entered_at, last_seen_in_radius_at, closest_approach_nm, observation_count, center_latitude, center_longitude
             from (select e.*, row_number() over (partition by e.icao24 order by e.entered_at desc) as rn
                     from airintel_private.encounters e where e.user_id = $1::uuid and e.icao24 = any($2::text[])) ranked
            where rn <= $3
            order by icao24, entered_at desc`,
          [userId, icaos, MAX_VISITS_PER_AIRCRAFT],
        ),
        db.query<{ icao24: string; type_code: string | null }>(
          `select distinct on (a.icao24) a.icao24, nullif(trim(r.payload->>'t'), '') as type_code
             from public.aircraft a
             join public.aircraft_positions p on p.aircraft_id = a.id
             join airintel_private.raw_observations r on r.position_id = p.id
            where a.icao24 = any($1::text[]) and p.observed_at >= now() - interval '30 days' and r.payload ? 't'
            order by a.icao24, p.observed_at desc`,
          [icaos],
        ).catch(() => ({ rows: [] as { icao24: string; type_code: string | null }[] })),
      ]);
      const visits = new Map<string, NettedAircraft["visits"]>();
      for (const row of encounters.rows) {
        const list = visits.get(row.icao24) ?? [];
        list.push({ enteredAt: iso(row.entered_at)!, lastSeenInRadiusAt: iso(row.last_seen_in_radius_at)!, closestMi: nmToMiles(row.closest_approach_nm), observationCount: Math.max(1, row.observation_count), centerLatitude: row.center_latitude ?? null, centerLongitude: row.center_longitude ?? null });
        visits.set(row.icao24, list);
      }
      const typeCodes = new Map(types.rows.flatMap((row) => (row.type_code ? [[row.icao24, row.type_code] as const] : [])));
      const registry = await lookupRegistryIdentities(db, kept.map((row) => row.icao24));
      const aircraft: NettedAircraft[] = kept.map((row) => ({
        icao24: row.icao24,
        callsign: row.last_callsign,
        registration: row.last_registration,
        registryRegistration: row.last_registration ? null : registry.get(row.icao24)?.nNumber ?? null,
        registryModel: typeCodes.get(row.icao24) ? null : registry.get(row.icao24)?.model ?? null,
        aircraftTypeCode: typeCodes.get(row.icao24) ?? null,
        visitCount: row.encounter_count,
        firstSeenAt: iso(row.first_encountered_at)!,
        lastSeenAt: iso(row.last_seen_in_radius_at)!,
        closestApproachMi: nmToMiles(row.closest_approach_nm),
        visits: visits.get(row.icao24) ?? [],
      }));
      const { assessments: patterns, status: patternStatus } = await assessLogPatterns(db, userId, aircraft, { registry });
      for (const item of aircraft) item.pattern = patterns.get(item.icao24) ?? null;
      const windowEnd = new Date();
      const earliest = Math.min(...kept.map((row) => row.first_encountered_at.getTime()));
      const net = await getWatchAreaRow(db, userId).then((row) => toNetStatus(row), () => null);
      return c.json({
        query: { latitude: lat, longitude: lon, radiusMi, radiusNm: milesToNm(radiusMi), hours, visitGapMinutes: VISIT_GAP_MINUTES },
        windowStart: new Date(Math.min(earliest, windowEnd.getTime())).toISOString(),
        windowEnd: windowEnd.toISOString(),
        receivedAt: windowEnd.toISOString(),
        algorithmVersion: NETTED_ALGORITHM_VERSION,
        truncated,
        aircraft,
        net,
        source: "log",
        patternStatus,
      });
    }

    async function track(rawIcao: string | undefined, hours: number) {
      const window = await loadWindow(rawIcao, hours);
      if ("error" in window) return window.error;
      const { rows } = await db.query<{
        provider: string; observation_registration: string | null; callsign: string | null; latitude: number; longitude: number;
        altitude_ft: number | null; altitude_source: string | null; ground_speed_kt: number | null; track_deg: number | null;
        vertical_rate_fpm: number | null; on_ground: boolean | null; observed_at: Date; received_at: Date;
      }>(
        `select s.key as provider, p.observation_registration, p.callsign, p.latitude, p.longitude, p.altitude_ft, p.altitude_source,
                p.ground_speed_kt, p.track_deg, p.vertical_rate_fpm, p.on_ground, p.observed_at, p.received_at
           from public.aircraft_positions p join public.data_sources s on s.id = p.source_id
          where p.aircraft_id = $1 and p.observed_at >= $2 and p.observed_at <= $3
          order by p.observed_at desc limit 10001`,
        [window.aircraft.id, window.windowStart, window.windowEnd],
      );
      const truncated = rows.length > 10_000;
      const points = rows.slice(0, 10_000).reverse().map((row) => ({
        provider: row.provider,
        icao24: window.aircraft.icao24,
        registration: row.observation_registration,
        callsign: row.callsign,
        latitude: row.latitude,
        longitude: row.longitude,
        altitudeFt: row.altitude_ft,
        altitudeSource: row.altitude_source,
        groundSpeedKt: row.ground_speed_kt,
        trackDeg: row.track_deg,
        verticalRateFpm: row.vertical_rate_fpm,
        onGround: row.on_ground,
        observedAt: iso(row.observed_at),
        receivedAt: iso(row.received_at),
      }));
      return c.json({
        aircraft: aircraftDto(window.aircraft),
        points,
        windowStart: window.windowStart.toISOString(),
        windowEnd: window.windowEnd.toISOString(),
        receivedAt: new Date().toISOString(),
        coverage: { returnedPoints: points.length, truncated, sources: [...new Set(points.map((point) => point.provider))] },
      });
    }
  });

const notMigrated = (error: unknown) => {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
    return code === "42P01" || code === "42703";
  };

  /** Save one control circle (slot 1 or 2) for the signed-in user. Returns the updated list with counts. */
  async function putControlArea(c: Context<{ Variables: AppVariables }>) {
    const text = await c.req.text().catch(() => "");
    if (text.length === 0 || text.length > 2_000) return c.json({ error: "invalid_control_area" }, 400);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return c.json({ error: "invalid_control_area" }, 400); }
    const parsed = controlAreaInputSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_control_area" }, 400);
    const userId = c.get("user").id;
    try {
      await upsertControlArea(db, userId, parsed.data);
      log("info", "net_control_area_saved", { slot: parsed.data.slot, enabled: parsed.data.enabled, radiusMi: parsed.data.radiusMi });
      return c.json(await listControlAreas(db, userId));
    } catch (error) {
      if (error instanceof ControlTooCloseError) return c.json({ error: "control_too_close", distanceMi: Math.round(error.distanceMi * 10) / 10, requiredMi: Math.round(error.requiredMi * 10) / 10 }, 422);
      log("error", "net_control_area_save_failed", errorFields(error));
      return c.json({ error: notMigrated(error) ? "net_not_migrated" : "history_query_failed" }, notMigrated(error) ? 503 : 500);
    }
  }

  /** Remove one control circle (and its sightings) for the signed-in user. */
  app.delete("/", async (c) => {
    if (c.req.query("action") !== "control-areas") return c.json({ error: "invalid_action" }, 400);
    const slot = Number(c.req.query("slot"));
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_CONTROL_AREAS) return c.json({ error: "invalid_control_area" }, 400);
    const userId = c.get("user").id;
    try {
      await deleteControlArea(db, userId, slot);
      return c.json(await listControlAreas(db, userId));
    } catch (error) {
      log("error", "net_control_area_delete_failed", errorFields(error));
      return c.json({ error: notMigrated(error) ? "net_not_migrated" : "history_query_failed" }, notMigrated(error) ? 503 : 500);
    }
  });

  /** Save / enable / pause the always-on net for the signed-in user (history grant already enforced upstream). */
  app.put("/", async (c) => {
    if (c.req.query("action") === "control-areas") return putControlArea(c);
    if (c.req.query("action") !== "watch-area") return c.json({ error: "invalid_action" }, 400);
    const text = await c.req.text().catch(() => "");
    if (text.length === 0 || text.length > 2_000) return c.json({ error: "invalid_watch_area" }, 400);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return c.json({ error: "invalid_watch_area" }, 400); }
    const parsed = watchAreaInputSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_watch_area" }, 400);
    try {
      const row = await upsertWatchArea(db, c.get("user").id, parsed.data);
      log("info", "net_watch_area_saved", { enabled: parsed.data.enabled, radiusMi: parsed.data.radiusMi });
      return c.json(watchAreaResponse(row));
    } catch (error) {
      log("error", "net_watch_area_save_failed", errorFields(error));
      return c.json({ error: notMigrated(error) ? "net_not_migrated" : "history_query_failed" }, notMigrated(error) ? 503 : 500);
    }
  });

  return app;
}
