import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "../http.js";
import { DEFAULT_GROUPS, fetchCelestrakGroups, predictPassesForRecord, propagateRecord, type CelestrakGroup } from "../orbital.js";

const allowedGroups = new Set<string>(DEFAULT_GROUPS);
const PASS_GROUPS = new Set<CelestrakGroup>(["STATIONS", "VISUAL", "WEATHER", "IRIDIUM-NEXT"]);
const MAX_PROPAGATIONS = 1500;
const MAX_CANDIDATES = 600;
const MAX_PASSES = 500;
const SEVEN_DAYS_MS = 7 * 86_400_000;

const nearbySchema = z.object({
  lat: z.coerce.number().finite().min(-90).max(90),
  lon: z.coerce.number().finite().min(-180).max(180),
  heightKm: z.coerce.number().finite().min(-1).max(20).default(0),
  minElevationDeg: z.coerce.number().finite().min(-90).max(90).default(0),
  at: z.iso.datetime({ offset: true }).optional(),
  groups: z.string().optional(),
});

const passesSchema = z.object({
  lat: z.coerce.number().finite().min(-90).max(90),
  lon: z.coerce.number().finite().min(-180).max(180),
  heightKm: z.coerce.number().finite().min(-1).max(20).default(0),
  hours: z.coerce.number().finite().min(1).max(168).default(24),
  start: z.iso.datetime({ offset: true }).optional(),
  groups: z.string().optional(),
});

function parseGroups(raw: string | undefined, filter?: ReadonlySet<CelestrakGroup>): CelestrakGroup[] {
  const requested = raw ? [...new Set(raw.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean))] : [...DEFAULT_GROUPS];
  if (requested.length === 0 || requested.some((group) => !allowedGroups.has(group))) throw new Error("invalid_groups");
  const groups = requested as CelestrakGroup[];
  return filter ? groups.filter((group) => filter.has(group)) : groups;
}

export function satellitesNearbyRoutes() {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/", async (c) => {
    const parsed = nearbySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_satellite_query" }, 400);
    let groups: CelestrakGroup[];
    try { groups = parseGroups(parsed.data.groups); } catch { return c.json({ error: "invalid_groups" }, 400); }
    const calculatedAt = parsed.data.at ? new Date(parsed.data.at) : new Date();
    if (!Number.isFinite(calculatedAt.getTime())) return c.json({ error: "invalid_calculation_time" }, 400);
    if (Math.abs(calculatedAt.getTime() - Date.now()) > SEVEN_DAYS_MS) return c.json({ error: "calculation_time_out_of_range" }, 400);
    const observer = { latitude: parsed.data.lat, longitude: parsed.data.lon, heightKm: parsed.data.heightKm };
    try {
      const records = await fetchCelestrakGroups(groups);
      if (records.length > MAX_PROPAGATIONS) return c.json({ error: "candidate_limit_exceeded", candidateCount: records.length, maxCandidates: MAX_PROPAGATIONS }, 422);
      const satellites = records
        .map((record) => propagateRecord(record, observer, calculatedAt))
        .filter((value) => value !== null && value.elevationDeg >= parsed.data.minElevationDeg)
        .sort((a, b) => b!.elevationDeg - a!.elevationDeg);
      const sources = [...new Map(records.map((record) => [record.group, { provider: "celestrak" as const, group: record.group, retrievedAt: record.retrievedAt, sourceUrl: record.sourceUrl }])).values()];
      return c.json({
        calculatedAt: calculatedAt.toISOString(),
        observer,
        sources,
        satellites,
        limitations: [
          "Satellite coordinates are calculated from CelesTrak GP element sets using SGP4; they are not directly observed positions.",
          "Accuracy degrades as an element set ages and can be affected by maneuvers or incomplete public catalog data.",
          "Above-horizon status does not establish optical visibility or sensor activity.",
        ],
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "satellite_engine_failure" }, 502);
    }
  });

  return app;
}

export function satellitePassesRoutes() {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/", async (c) => {
    const parsed = passesSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_pass_query" }, 400);
    let groups: CelestrakGroup[];
    try { groups = parseGroups(parsed.data.groups, PASS_GROUPS); } catch { return c.json({ error: "invalid_groups" }, 400); }
    const start = parsed.data.start ? new Date(parsed.data.start) : new Date();
    if (!Number.isFinite(start.getTime())) return c.json({ error: "invalid_start_time" }, 400);
    if (Math.abs(start.getTime() - Date.now()) > SEVEN_DAYS_MS) return c.json({ error: "start_time_out_of_range" }, 400);
    const end = new Date(start.getTime() + parsed.data.hours * 3_600_000);
    const observer = { latitude: parsed.data.lat, longitude: parsed.data.lon, heightKm: parsed.data.heightKm };
    try {
      const allRecords = await fetchCelestrakGroups(groups);
      const passes = allRecords
        .slice(0, MAX_CANDIDATES)
        .flatMap((record) => predictPassesForRecord(record, observer, start.getTime(), end.getTime()))
        .sort((a, b) => Date.parse(a.riseAt) - Date.parse(b.riseAt))
        .slice(0, MAX_PASSES);
      return c.json({
        calculatedAt: new Date().toISOString(),
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
        observer,
        passes,
        limitations: [
          "Passes are calculated from CelesTrak GP element sets using SGP4 and a geometric zero-degree horizon.",
          "Terrain, buildings, refraction, illumination, weather, brightness, and optical visibility are not modeled.",
          allRecords.length > MAX_CANDIDATES
            ? `Pass prediction was limited to the first ${MAX_CANDIDATES} deduplicated candidates to bound synchronous compute.`
            : "Candidate count remained within the synchronous propagation limit.",
        ],
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "pass_engine_failure" }, 502);
    }
  });

  return app;
}
