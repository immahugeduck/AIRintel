import { Hono } from "hono";
import { z } from "zod";
import { iso, type Queryable } from "../db";
import { percentile, type AppVariables } from "../http";

const icaoSchema = z.string().trim().toLowerCase().regex(/^[0-9a-f]{6}$/);

const unknownField = (source = "FAA registry") => ({ value: null, evidenceLevel: "unknown", status: "unknown", source, sourceRecordId: null, sourceEffectiveAt: null, matchMethod: null, limitations: ["No time-applicable source record is available."] });

type RegistryRow = {
  match_status: string; match_method: string; limitations: string[]; manual_review_status: string;
  record_id: string; snapshot_date: string; n_number: string; manufacturer_name: string | null; model_name: string | null; serial_number: string | null;
  registration_status: string | null; registrant_display_name: string | null; registrant_kind: string | null; owner_visibility: string;
};

export function profileRoutes(db: Queryable) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/", async (c) => {
    const parsedIcao = icaoSchema.safeParse(c.req.query("icao24"));
    if (!parsedIcao.success) return c.json({ error: "invalid_icao24" }, 400);
    try {
      const aircraftResult = await db.query<{ id: string; icao24: string; registration: string | null; first_seen_at: Date; last_seen_at: Date }>(
        "select id, icao24, registration, first_seen_at, last_seen_at from public.aircraft where icao24 = $1",
        [parsedIcao.data],
      );
      const aircraft = aircraftResult.rows[0];
      if (!aircraft) return c.json({ error: "aircraft_not_found" }, 404);

      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 90 * 86_400_000);
      const [matchResult, operatorResult, positionResult] = await Promise.all([
        db.query<RegistryRow>(
          `select m.match_status, m.match_method, m.limitations, m.manual_review_status,
                  r.id as record_id, r.snapshot_date::text as snapshot_date, r.n_number, r.manufacturer_name, r.model_name, r.serial_number,
                  r.registration_status, r.registrant_display_name, r.registrant_kind, r.owner_visibility
             from public.aircraft_registry_matches m join public.aircraft_registry_records r on r.id = m.registry_record_id
            where m.aircraft_id = $1 and m.match_status <> 'conflict'
            order by m.matched_at desc limit 1`,
          [aircraft.id],
        ),
        db.query<{ operator_name: string; source_url: string; source_effective_at: Date | null; limitations: string[] }>(
          `select operator_name, source_url, source_effective_at, limitations from public.aircraft_operator_associations
            where aircraft_id = $1 and association_status = 'documented' and review_status = 'verified'
            order by retrieved_at desc limit 1`,
          [aircraft.id],
        ),
        db.query<{ altitude_ft: number | null; altitude_source: string | null; ground_speed_kt: number | null; on_ground: boolean | null; observed_at: Date; source_key: string }>(
          `select p.altitude_ft, p.altitude_source, p.ground_speed_kt, p.on_ground, p.observed_at, s.key as source_key
             from public.aircraft_positions p join public.data_sources s on s.id = p.source_id
            where p.aircraft_id = $1 and p.observed_at >= $2 and p.observed_at <= $3
            order by p.observed_at desc limit 5001`,
          [aircraft.id, windowStart, windowEnd],
        ),
      ]);

      const record = matchResult.rows[0] ?? null;
      const effectiveAt = record ? `${record.snapshot_date}T00:00:00Z` : null;
      const sourced = (value: string | null, status = "available", limitations: string[] = []) => record
        ? { value, evidenceLevel: value == null ? "unknown" : "observed", status: value == null ? "unknown" : status, source: "FAA Releasable Aircraft Database", sourceRecordId: record.record_id, sourceEffectiveAt: effectiveAt, matchMethod: record.match_method, limitations }
        : unknownField();
      const ownerIsDisplayable = record?.owner_visibility === "displayable_entity" && record.registrant_kind !== "individual";
      const ownerStatus = record?.owner_visibility === "withheld" || record?.owner_visibility === "individual_redacted" ? "withheld_or_unavailable" : "unknown";
      const registeredOwner = record ? sourced(ownerIsDisplayable ? record.registrant_display_name : null, ownerIsDisplayable ? "available" : ownerStatus, ["FAA registration does not establish who operated or occupied a particular flight."]) : unknownField();

      const truncated = positionResult.rows.length > 5_000;
      const positions = positionResult.rows.slice(0, 5_000);
      const bySource = new Map<string, typeof positions>();
      for (const position of positions) bySource.set(position.source_key, [...(bySource.get(position.source_key) ?? []), position]);
      const statisticsBySource = [...bySource.entries()].map(([provider, sourcePositions]) => {
        const airborne = sourcePositions.filter((position) => position.on_ground === false);
        const altitudes = airborne.flatMap((position) => (position.altitude_ft == null ? [] : [position.altitude_ft]));
        const speeds = airborne.flatMap((position) => (position.ground_speed_kt == null ? [] : [position.ground_speed_kt]));
        const altitudeSources = new Set(airborne.flatMap((position) => (position.altitude_source ? [position.altitude_source] : [])));
        const sufficientAltitudes = altitudes.length >= 20;
        const sufficientSpeeds = speeds.length >= 20;
        return {
          provider,
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          validObservationCount: airborne.length,
          observedDays: new Set(airborne.map((position) => position.observed_at.toISOString().slice(0, 10))).size,
          medianAltitudeFt: sufficientAltitudes ? percentile(altitudes, 0.5) : null,
          p10AltitudeFt: sufficientAltitudes ? percentile(altitudes, 0.1) : null,
          p90AltitudeFt: sufficientAltitudes ? percentile(altitudes, 0.9) : null,
          altitudeBasis: altitudeSources.size === 0 ? "unknown" : altitudeSources.size > 1 ? "mixed" : [...altitudeSources][0],
          medianGroundSpeedKt: sufficientSpeeds ? percentile(speeds, 0.5) : null,
          p10GroundSpeedKt: sufficientSpeeds ? percentile(speeds, 0.1) : null,
          p90GroundSpeedKt: sufficientSpeeds ? percentile(speeds, 0.9) : null,
          onGroundExcludedCount: sourcePositions.filter((position) => position.on_ground === true).length,
          unknownGroundStateExcludedCount: sourcePositions.filter((position) => position.on_ground == null).length,
          truncated,
          algorithmVersion: "profile-stats-v1",
        };
      });

      const operator = operatorResult.rows[0];
      const documentedOperator = operator
        ? { value: operator.operator_name, evidenceLevel: "observed", status: "available", source: operator.source_url, sourceRecordId: null, sourceEffectiveAt: iso(operator.source_effective_at), matchMethod: "independently_documented", limitations: operator.limitations ?? [] }
        : unknownField("Independent operator documentation");

      return c.json({
        aircraftId: aircraft.id,
        icao24: aircraft.icao24,
        observedRegistration: aircraft.registration,
        firstObservedAt: iso(aircraft.first_seen_at),
        lastObservedAt: iso(aircraft.last_seen_at),
        registryMatch: {
          status: record?.match_status ?? "unmatched",
          method: record?.match_method ?? null,
          snapshotEffectiveAt: effectiveAt,
          nNumber: record ? sourced(record.n_number) : unknownField(),
          manufacturer: record ? sourced(record.manufacturer_name) : unknownField(),
          model: record ? sourced(record.model_name) : unknownField(),
          serialNumber: record ? sourced(record.serial_number) : unknownField(),
          registrationStatus: record ? sourced(record.registration_status) : unknownField(),
          registeredOwner,
        },
        operator: { documentedOperator, actualOperatorForFlight: "Unknown" },
        statisticsBySource,
        receivedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[profile] query failed:", error instanceof Error ? error.message : error);
      return c.json({ error: "profile_query_failed" }, 500);
    }
  });

  return app;
}
