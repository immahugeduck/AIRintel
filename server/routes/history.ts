import { Hono } from "hono";
import { z } from "zod";
import { iso, type Queryable } from "../db";
import type { AppVariables } from "../http";

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
      return c.json({ error: "invalid_action" }, 400);
    } catch (error) {
      console.error("[history] query failed:", error instanceof Error ? error.message : error);
      return c.json({ error: "history_query_failed" }, 500);
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
        const distanceNm = Math.hypot(current.latitude - previous.latitude, current.longitude - previous.longitude) * 69;
        totalDistanceNm += distanceNm;
        if (distanceNm <= loiteringRadiusNm) {
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
      if (rawLat == null || rawLon == null || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radiusNm)) return c.json({ error: "invalid_spatial_query" }, 400);
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - hours * 3_600_000);
      const { rows } = await db.query<AircraftRow & { callsign: string | null; latitude: number; longitude: number; altitude_ft: number | null; observed_at: Date }>(
        `select ${aircraftColumns}, p.callsign, p.latitude, p.longitude, p.altitude_ft, p.observed_at
           from public.aircraft_positions p join public.aircraft a on a.id = p.aircraft_id
          where p.observed_at >= $1 and p.observed_at <= $2 order by p.observed_at desc limit 5000`,
        [windowStart, windowEnd],
      );
      const matches = rows
        .map((row) => {
          const distanceNm = Math.hypot(row.latitude - lat, row.longitude - lon) * 69;
          if (distanceNm > radiusNm) return null;
          return { icao24: row.icao24, registration: row.registration, callsign: row.callsign ?? null, latitude: row.latitude, longitude: row.longitude, observedAt: iso(row.observed_at), distanceNm, altitudeFt: row.altitude_ft ?? null };
        })
        .filter((value): value is NonNullable<typeof value> => value != null)
        .slice(0, 50);
      return c.json({ query: { latitude: lat, longitude: lon, radiusNm }, receivedAt: new Date().toISOString(), matches });
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

  return app;
}
