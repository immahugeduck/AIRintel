import { z } from "npm:zod@4.0.15";
import { DEFAULT_GROUPS, fetchCelestrakGroups, propagateRecord, type CelestrakGroup } from "../_shared/orbital.ts";

const querySchema = z.object({
  lat: z.coerce.number().finite().min(-90).max(90),
  lon: z.coerce.number().finite().min(-180).max(180),
  heightKm: z.coerce.number().finite().min(-1).max(20).default(0),
  minElevationDeg: z.coerce.number().finite().min(-90).max(90).default(0),
  at: z.iso.datetime({ offset: true }).optional(),
  groups: z.string().optional(),
});

const allowedOrigins = new Set((Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const allowedGroups = new Set<string>(DEFAULT_GROUPS);
const MAX_PROPAGATIONS = 1500;

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}

function parseGroups(raw?: string): CelestrakGroup[] {
  if (!raw) return [...DEFAULT_GROUPS];
  const groups = [...new Set(raw.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean))];
  if (groups.length === 0 || groups.some((group) => !allowedGroups.has(group))) throw new Error("invalid_groups");
  return groups as CelestrakGroup[];
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";
  const headers = cors(origin);
  if (!allowedOrigins.has(origin)) return new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return new Response(JSON.stringify({ error: "invalid_satellite_query" }), { status: 400, headers });

  let groups: CelestrakGroup[];
  try {
    groups = parseGroups(parsed.data.groups);
  } catch {
    return new Response(JSON.stringify({ error: "invalid_groups" }), { status: 400, headers });
  }

  const calculatedAt = parsed.data.at ? new Date(parsed.data.at) : new Date();
  if (!Number.isFinite(calculatedAt.getTime())) return new Response(JSON.stringify({ error: "invalid_calculation_time" }), { status: 400, headers });
  if (Math.abs(calculatedAt.getTime() - Date.now()) > 7 * 86_400_000) {
    return new Response(JSON.stringify({ error: "calculation_time_out_of_range" }), { status: 400, headers });
  }

  const observer = { latitude: parsed.data.lat, longitude: parsed.data.lon, heightKm: parsed.data.heightKm };

  try {
    const records = await fetchCelestrakGroups(groups);
    if (records.length > MAX_PROPAGATIONS) {
      return new Response(JSON.stringify({ error: "candidate_limit_exceeded", candidateCount: records.length, maxCandidates: MAX_PROPAGATIONS }), { status: 422, headers });
    }

    const satellites = records
      .map((record) => propagateRecord(record, observer, calculatedAt))
      .filter((value) => value !== null && value.elevationDeg >= parsed.data.minElevationDeg)
      .sort((a, b) => b.elevationDeg - a.elevationDeg);

    const sources = [...new Map(records.map((record) => [record.group, {
      provider: "celestrak" as const,
      group: record.group,
      retrievedAt: record.retrievedAt,
      sourceUrl: record.sourceUrl,
    }])).values()];

    return new Response(JSON.stringify({
      calculatedAt: calculatedAt.toISOString(),
      observer,
      sources,
      satellites,
      limitations: [
        "Satellite coordinates are calculated from CelesTrak GP element sets using SGP4; they are not directly observed positions.",
        "Accuracy degrades as an element set ages and can be affected by maneuvers or incomplete public catalog data.",
        "Above-horizon status does not establish optical visibility or sensor activity.",
      ],
    }), { status: 200, headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : "satellite_engine_failure";
    return new Response(JSON.stringify({ error: code }), { status: 502, headers });
  }
});
