import { z } from "npm:zod@4.0.15";

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radiusNm: z.coerce.number().positive().max(100),
});

const allowedOrigins = new Set((Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((v) => v.trim()).filter(Boolean));

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";
  const cors = { "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "", "Vary": "Origin", "Content-Type": "application/json" };
  if (!allowedOrigins.has(origin)) return new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers: cors });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: cors });

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return new Response(JSON.stringify({ error: "invalid_spatial_query" }), { status: 400, headers: cors });

  if (!Deno.env.get("ADSB_PROVIDER") || !Deno.env.get("ADSB_API_BASE_URL") || !Deno.env.get("ADSB_API_KEY")) {
    return new Response(JSON.stringify({ error: "provider_not_configured" }), { status: 503, headers: cors });
  }

  // A provider implementation is intentionally absent until its documented contract,
  // units, licensing, limits, and authentication method pass the onboarding gate.
  return new Response(JSON.stringify({ error: "provider_adapter_not_implemented" }), { status: 501, headers: cors });
});
