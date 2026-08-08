import { createClient } from "npm:@supabase/supabase-js@2.55.0";
import { z } from "npm:zod@4.0.15";

const icaoSchema = z.string().trim().toLowerCase().regex(/^[0-9a-f]{6}$/);
const allowedOrigins = new Set((Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

const json = (body: unknown, status: number, origin: string) => new Response(JSON.stringify(body), {
  status,
  headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", Vary: "Origin", "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache" },
});

const percentile = (values: number[], quantile: number) => {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = (ordered.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return ordered[lower]!;
  return ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (index - lower);
};

const unknownField = (source = "FAA registry") => ({ value: null, evidenceLevel: "unknown", status: "unknown", source, sourceRecordId: null, sourceEffectiveAt: null, matchMethod: null, limitations: ["No time-applicable source record is available."] });

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigins.has(origin)) return json({ error: "origin_not_allowed" }, 403, "");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", Vary: "Origin" } });
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
  if (authData.user.app_metadata?.airintel_profile_access !== true) return json({ error: "profile_access_denied" }, 403, origin);
  const now = Date.now();
  const bucket = rateBuckets.get(authData.user.id);
  if (!bucket || bucket.resetAt <= now) rateBuckets.set(authData.user.id, { count: 1, resetAt: now + 60_000 });
  else if (bucket.count >= 20) return json({ error: "rate_limited", retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) }, 429, origin);
  else bucket.count += 1;

  const parsedIcao = icaoSchema.safeParse(new URL(request.url).searchParams.get("icao24"));
  if (!parsedIcao.success) return json({ error: "invalid_icao24" }, 400, origin);
  const database = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: aircraft, error: aircraftError } = await database.from("aircraft").select("id,icao24,registration,first_seen_at,last_seen_at").eq("icao24", parsedIcao.data).maybeSingle();
  if (aircraftError) return json({ error: "profile_query_failed" }, 500, origin);
  if (!aircraft) return json({ error: "aircraft_not_found" }, 404, origin);

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 90 * 86_400_000);
  const [matchResult, operatorResult, positionResult] = await Promise.all([
    database.from("aircraft_registry_matches").select("match_status,match_method,limitations,manual_review_status,record:registry_record_id(id,snapshot_date,n_number,manufacturer_name,model_name,serial_number,registration_status,registrant_display_name,registrant_kind,owner_visibility)").eq("aircraft_id", aircraft.id).neq("match_status", "conflict").order("matched_at", { ascending: false }).limit(1).maybeSingle(),
    database.from("aircraft_operator_associations").select("operator_name,source_url,source_effective_at,limitations").eq("aircraft_id", aircraft.id).eq("association_status", "documented").eq("review_status", "verified").order("retrieved_at", { ascending: false }).limit(1).maybeSingle(),
    database.from("aircraft_positions").select("altitude_ft,altitude_source,ground_speed_kt,on_ground,observed_at,data_sources!inner(key)").eq("aircraft_id", aircraft.id).gte("observed_at", windowStart.toISOString()).lte("observed_at", windowEnd.toISOString()).order("observed_at", { ascending: false }).limit(5_001).abortSignal(AbortSignal.timeout(8_000)),
  ]);
  if (matchResult.error || operatorResult.error || positionResult.error) return json({ error: "profile_query_failed" }, 500, origin);

  const match = matchResult.data;
  const record = match ? (Array.isArray(match.record) ? match.record[0] : match.record) : null;
  const effectiveAt = record ? `${record.snapshot_date}T00:00:00Z` : null;
  const sourced = (value: string | null, status = "available", limitations: string[] = []) => record ? ({ value, evidenceLevel: value == null ? "unknown" : "observed", status: value == null ? "unknown" : status, source: "FAA Releasable Aircraft Database", sourceRecordId: record.id, sourceEffectiveAt: effectiveAt, matchMethod: match?.match_method ?? null, limitations }) : unknownField();
  const ownerIsDisplayable = record?.owner_visibility === "displayable_entity" && record.registrant_kind !== "individual";
  const ownerStatus = record?.owner_visibility === "withheld" || record?.owner_visibility === "individual_redacted" ? "withheld_or_unavailable" : "unknown";
  const registeredOwner = record ? sourced(ownerIsDisplayable ? record.registrant_display_name : null, ownerIsDisplayable ? "available" : ownerStatus, ["FAA registration does not establish who operated or occupied a particular flight."]) : unknownField();

  const positions = (positionResult.data ?? []).slice(0, 5_000);
  const truncated = (positionResult.data?.length ?? 0) > 5_000;
  const bySource = new Map<string, typeof positions>();
  for (const position of positions) {
    const source = Array.isArray(position.data_sources) ? position.data_sources[0]?.key : position.data_sources.key;
    if (source) bySource.set(source, [...(bySource.get(source) ?? []), position]);
  }
  const statisticsBySource = [...bySource.entries()].map(([provider, sourcePositions]) => {
    const airborne = sourcePositions.filter((position) => position.on_ground === false);
    const altitudes = airborne.flatMap((position) => position.altitude_ft == null ? [] : [position.altitude_ft]);
    const speeds = airborne.flatMap((position) => position.ground_speed_kt == null ? [] : [position.ground_speed_kt]);
    const altitudeSources = new Set(airborne.flatMap((position) => position.altitude_source ? [position.altitude_source] : []));
    const sufficientAltitudes = altitudes.length >= 20;
    const sufficientSpeeds = speeds.length >= 20;
    return { provider, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(), validObservationCount: airborne.length, observedDays: new Set(airborne.map((position) => position.observed_at.slice(0, 10))).size, medianAltitudeFt: sufficientAltitudes ? percentile(altitudes, 0.5) : null, p10AltitudeFt: sufficientAltitudes ? percentile(altitudes, 0.1) : null, p90AltitudeFt: sufficientAltitudes ? percentile(altitudes, 0.9) : null, altitudeBasis: altitudeSources.size === 0 ? "unknown" : altitudeSources.size > 1 ? "mixed" : [...altitudeSources][0], medianGroundSpeedKt: sufficientSpeeds ? percentile(speeds, 0.5) : null, p10GroundSpeedKt: sufficientSpeeds ? percentile(speeds, 0.1) : null, p90GroundSpeedKt: sufficientSpeeds ? percentile(speeds, 0.9) : null, onGroundExcludedCount: sourcePositions.filter((position) => position.on_ground === true).length, unknownGroundStateExcludedCount: sourcePositions.filter((position) => position.on_ground == null).length, truncated, algorithmVersion: "profile-stats-v1" };
  });

  const operator = operatorResult.data;
  const documentedOperator = operator ? ({ value: operator.operator_name, evidenceLevel: "observed", status: "available", source: operator.source_url, sourceRecordId: null, sourceEffectiveAt: operator.source_effective_at, matchMethod: "independently_documented", limitations: operator.limitations ?? [] }) : unknownField("Independent operator documentation");
  return json({ aircraftId: aircraft.id, icao24: aircraft.icao24, observedRegistration: aircraft.registration, firstObservedAt: aircraft.first_seen_at, lastObservedAt: aircraft.last_seen_at, registryMatch: { status: match?.match_status ?? "unmatched", method: match?.match_method ?? null, snapshotEffectiveAt: effectiveAt, nNumber: record ? sourced(record.n_number) : unknownField(), manufacturer: record ? sourced(record.manufacturer_name) : unknownField(), model: record ? sourced(record.model_name) : unknownField(), serialNumber: record ? sourced(record.serial_number) : unknownField(), registrationStatus: record ? sourced(record.registration_status) : unknownField(), registeredOwner }, operator: { documentedOperator, actualOperatorForFlight: "Unknown" }, statisticsBySource, receivedAt: new Date().toISOString() }, 200, origin);
});
