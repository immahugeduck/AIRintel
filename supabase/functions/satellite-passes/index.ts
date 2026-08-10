import { z } from "npm:zod@4.0.15";
import { DEFAULT_GROUPS, fetchCelestrakGroups, predictPassesForRecord, type CelestrakGroup } from "../_shared/orbital.ts";

const querySchema = z.object({
  lat: z.coerce.number().finite().min(-90).max(90),
  lon: z.coerce.number().finite().min(-180).max(180),
  heightKm: z.coerce.number().finite().min(-1).max(20).default(0),
  hours: z.coerce.number().finite().min(1).max(168).default(24),
  start: z.iso.datetime({ offset: true }).optional(),
  groups: z.string().optional(),
});

const allowedOrigins = new Set((Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const allowedGroups = new Set<string>(DEFAULT_GROUPS);
const PASS_GROUPS = new Set<CelestrakGroup>(["STATIONS", "VISUAL", "WEATHER", "IRIDIUM-NEXT"]);
const MAX_CANDIDATES = 600;
const MAX_PASSES = 500;

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
  const requested = raw
    ? [...new Set(raw.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean))]
    : [...DEFAULT_GROUPS];
  if (requested.length === 0 || requested.some((group) => !allowedGroups.has(group))) throw new Error("invalid_groups");
  return (requested as CelestrakGroup[]).filter((group) => PASS_GROUPS.has(group));
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";
  const headers = cors(origin);
  if (!allowedOrigins.has(origin)) return new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return new Response(JSON.stringify({ error: "invalid_pass_query" }), { status: 400, headers });

  let groups: CelestrakGroup[];
  try {
    groups = parseGroups(parsed.data.groups);
  } catch {
    return new Response(JSON.stringify({ error: "invalid_groups" }), { status: 400, headers });
  }

  const start = parsed.data.start ? new Date(parsed.data.start) : new Date();
  if (!Number.isFinite(start.getTime())) return new Response(JSON.stringify({ error: "invalid_start_time" }), { status: 400, headers });
  if (Math.abs(start.getTime() - Date.now()) > 7 * 86_400_000) {
    return new Response(JSON.stringify({ error: "start_time_out_of_range" }), { status: 400, headers });
  }

  const end = new Date(start.getTime() + parsed.data.hours * 3_600_000);
  const observer = { latitude: parsed.data.lat, longitude: parsed.data.lon, heightKm: parsed.data.heightKm };

  try {
    const allRecords = await fetchCelestrakGroups(groups);
    const records = allRecords.slice(0, MAX_CANDIDATES);
    const passes = records
      .flatMap((record) => predictPassesForRecord(record, observer, start.getTime(), end.getTime()))
      .sort((a, b) => Date.parse(a.riseAt) - Date.parse(b.riseAt))
      .slice(0, MAX_PASSES);

    return new Response(JSON.stringify({
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
    }), { status: 200, headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : "pass_engine_failure";
    return new Response(JSON.stringify({ error: code }), { status: 502, headers });
  }
});
