import { createClient } from "npm:@supabase/supabase-js@2.55.0";
import { z } from "npm:zod@4.0.15";

const searchSchema = z.string().trim().min(2).max(24).regex(/^[a-zA-Z0-9-]+$/);
const icaoSchema = z.string().trim().toLowerCase().regex(/^[0-9a-f]{6}$/);
const allowedOrigins = new Set(
  (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
);
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

const json = (body: unknown, status: number, origin: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigins.has(origin)) return json({ error: "origin_not_allowed" }, 403, "");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", Vary: "Origin" } });
  }
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceKey || !publishableKey) return json({ error: "database_not_configured" }, 503, origin);
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "authentication_required" }, 401, origin);
  const authClient = createClient(supabaseUrl, publishableKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await authClient.auth.getUser();
  if (authError || !authData.user || authData.user.is_anonymous) return json({ error: "authentication_required" }, 401, origin);
  if (authData.user.app_metadata?.airintel_access !== true) return json({ error: "history_access_denied" }, 403, origin);
  const now = Date.now();
  const bucket = rateBuckets.get(authData.user.id);
  if (!bucket || bucket.resetAt <= now) rateBuckets.set(authData.user.id, { count: 1, resetAt: now + 60_000 });
  else if (bucket.count >= 30) return json({ error: "rate_limited", retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) }, 429, origin);
  else bucket.count += 1;
  const database = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (action === "search") {
    const parsed = searchSchema.safeParse(url.searchParams.get("q"));
    if (!parsed.success) return json({ error: "invalid_search" }, 400, origin);
    const query = parsed.data.toUpperCase();
    const [identityResult, callsignResult, aliasResult] = await Promise.all([
      database.from("aircraft").select("id,icao24,registration,first_seen_at,last_seen_at").or(`icao24.ilike.${query}%,registration.ilike.${query}%`).order("last_seen_at", { ascending: false }).limit(50),
      database.from("aircraft_positions").select("aircraft:aircraft_id(id,icao24,registration,first_seen_at,last_seen_at)").ilike("callsign", `${query}%`).order("observed_at", { ascending: false }).limit(50),
      database.from("aircraft_aliases").select("aircraft:aircraft_id(id,icao24,registration,first_seen_at,last_seen_at)").ilike("alias_value", `${query}%`).order("last_observed_at", { ascending: false }).limit(50),
    ]);
    if (identityResult.error || callsignResult.error || aliasResult.error) return json({ error: "history_query_failed" }, 500, origin);
    const matches = new Map<string, Record<string, unknown>>();
    for (const row of identityResult.data ?? []) matches.set(row.id, row);
    for (const row of callsignResult.data ?? []) {
      const aircraft = Array.isArray(row.aircraft) ? row.aircraft[0] : row.aircraft;
      if (aircraft) matches.set(aircraft.id, aircraft);
    }
    for (const row of aliasResult.data ?? []) {
      const aircraft = Array.isArray(row.aircraft) ? row.aircraft[0] : row.aircraft;
      if (aircraft) matches.set(aircraft.id, aircraft);
    }
    const data = [...matches.values()].sort((a, b) => Date.parse(String(b.last_seen_at)) - Date.parse(String(a.last_seen_at))).slice(0, 50);
    return json(
      {
        aircraft: data.map((row) => ({
          id: row.id,
          icao24: row.icao24,
          registration: row.registration,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
        })),
        receivedAt: new Date().toISOString(),
      },
      200,
      origin,
    );
  }

  if (action === "insights") {
    const parsed = icaoSchema.safeParse(url.searchParams.get("icao24"));
    const hours = Math.min(72, Math.max(1, Number(url.searchParams.get("hours") ?? 24)));
    if (!parsed.success || !Number.isFinite(hours)) return json({ error: "invalid_track_query" }, 400, origin);
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - hours * 3_600_000);
    const { data: aircraft, error: aircraftError } = await database
      .from("aircraft")
      .select("id,icao24,registration,first_seen_at,last_seen_at")
      .eq("icao24", parsed.data)
      .maybeSingle();
    if (aircraftError) return json({ error: "history_query_failed" }, 500, origin);
    if (!aircraft) return json({ error: "aircraft_not_found" }, 404, origin);
    const { data: positions, error: positionsError } = await database
      .from("aircraft_positions")
      .select("latitude,longitude,altitude_ft,ground_speed_kt,observed_at")
      .eq("aircraft_id", aircraft.id)
      .gte("observed_at", windowStart.toISOString())
      .lte("observed_at", windowEnd.toISOString())
      .order("observed_at", { ascending: false })
      .limit(10_001)
      .abortSignal(AbortSignal.timeout(8_000));
    if (positionsError) return json({ error: "history_query_failed" }, 500, origin);
    const validPositions = positions ?? [];
    const altitudeValues = validPositions.map((row) => row.altitude_ft).filter((value): value is number => value != null);
    const speedValues = validPositions.map((row) => row.ground_speed_kt).filter((value): value is number => value != null);
    return json(
      {
        aircraft: {
          id: aircraft.id,
          icao24: aircraft.icao24,
          registration: aircraft.registration,
          firstSeenAt: aircraft.first_seen_at,
          lastSeenAt: aircraft.last_seen_at,
        },
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        receivedAt: new Date().toISOString(),
        summary: {
          pointCount: validPositions.length,
          sourceCount: new Set(validPositions.map((row) => row.data_sources?.[0]?.key).filter(Boolean)).size,
          altitudeFt: {
            min: altitudeValues.length > 0 ? Math.min(...altitudeValues) : null,
            max: altitudeValues.length > 0 ? Math.max(...altitudeValues) : null,
            average: altitudeValues.length > 0 ? altitudeValues.reduce((sum, value) => sum + value, 0) / altitudeValues.length : null,
          },
          groundSpeedKt: {
            min: speedValues.length > 0 ? Math.min(...speedValues) : null,
            max: speedValues.length > 0 ? Math.max(...speedValues) : null,
            average: speedValues.length > 0 ? speedValues.reduce((sum, value) => sum + value, 0) / speedValues.length : null,
          },
        },
      },
      200,
      origin,
    );
  }

  if (action === "track") {
    const parsed = icaoSchema.safeParse(url.searchParams.get("icao24"));
    const hours = Math.min(24, Math.max(1, Number(url.searchParams.get("hours") ?? 24)));
    if (!parsed.success || !Number.isFinite(hours)) return json({ error: "invalid_track_query" }, 400, origin);
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - hours * 3_600_000);
    const { data: aircraft, error: aircraftError } = await database
      .from("aircraft")
      .select("id,icao24,registration,first_seen_at,last_seen_at")
      .eq("icao24", parsed.data)
      .maybeSingle();
    if (aircraftError) return json({ error: "history_query_failed" }, 500, origin);
    if (!aircraft) return json({ error: "aircraft_not_found" }, 404, origin);

    const { data: positions, error: positionsError } = await database
      .from("aircraft_positions")
      .select("callsign,observation_registration,latitude,longitude,altitude_ft,altitude_source,ground_speed_kt,track_deg,vertical_rate_fpm,on_ground,observed_at,received_at,data_sources!inner(key)")
      .eq("aircraft_id", aircraft.id)
      .gte("observed_at", windowStart.toISOString())
      .lte("observed_at", windowEnd.toISOString())
      .order("observed_at", { ascending: false })
      .limit(10_001)
      .abortSignal(AbortSignal.timeout(8_000));
    if (positionsError) return json({ error: "history_query_failed" }, 500, origin);

    const truncated = (positions?.length ?? 0) > 10_000;
    const selectedPositions = (positions ?? []).slice(0, 10_000).reverse();
    const points = selectedPositions.map((row) => {
      const source = Array.isArray(row.data_sources) ? row.data_sources[0] : row.data_sources;
      return {
        provider: source?.key,
        icao24: aircraft.icao24,
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
        observedAt: row.observed_at,
        receivedAt: row.received_at,
      };
    });
    return json(
      {
        aircraft: {
          id: aircraft.id,
          icao24: aircraft.icao24,
          registration: aircraft.registration,
          firstSeenAt: aircraft.first_seen_at,
          lastSeenAt: aircraft.last_seen_at,
        },
        points,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        receivedAt: new Date().toISOString(),
        coverage: { returnedPoints: points.length, truncated, sources: [...new Set(points.map((point) => point.provider).filter(Boolean))] },
      },
      200,
      origin,
    );
  }

  return json({ error: "invalid_action" }, 400, origin);
});
