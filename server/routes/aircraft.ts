import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "../http.js";
import { recordLiveObservations, type LiveRecordingDeps } from "../live-recording.js";
import { log, errorFields } from "../logger.js";
import { classifyProviderError, fetchLiveAircraft, type AdsbProviderConfig, type ProviderFetchOptions } from "../providers/adsb.js";

/**
 * Live-view provider waits. With fallbacks: adsb.lol 8 s once, then adsb.fi / airplanes.live 6 s each, 22 s total, so a
 * dead primary costs one wait instead of two before the map gets fallback data. Without fallbacks: 8 s plus one retry.
 */
export function liveProviderOptions(adsb: AdsbProviderConfig): ProviderFetchOptions {
  return (adsb.fallbacks?.length ?? 0) > 0 ? { timeoutMs: 8_000, retries: 0, fallbackTimeoutMs: 6_000, budgetMs: 22_000 } : { timeoutMs: 8_000, retries: 1 };
}

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radiusNm: z.coerce.number().positive().max(100),
  /** How the live view chose its center (follow-me fix or fixed location); tags the caller's encounters. Optional. */
  center: z.enum(["follow", "fixed"]).optional(),
});

/** Live-aircraft gateway. Providers are gated by docs/provider-onboarding.md and ADSB_* env. */
export function aircraftRoutes(options: { adsb: AdsbProviderConfig | null; recording?: LiveRecordingDeps | null }) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.get("/", async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_spatial_query" }, 400);
    if (!options.adsb) return c.json({ error: "provider_not_configured" }, 503);
    try {
      const result = await fetchLiveAircraft(options.adsb, { lat: parsed.data.lat, lon: parsed.data.lon, radiusNm: parsed.data.radiusNm }, fetch, liveProviderOptions(options.adsb));
      const providerFailures = result.providerFailures ?? [];
      if (providerFailures.length > 0) log("warn", "aircraft_provider_fallback", { served: result.sources[0], failed: providerFailures.map((f) => `${f.provider}=${f.code}${f.detail ? `(${f.detail})` : ""}`).join("; ") });
      // Signed-in users with the history grant contribute these real observations to the flight recorder.
      const recording = await recordLiveObservations(options.recording ?? null, c.req.header("authorization"), { latitude: parsed.data.lat, longitude: parsed.data.lon, radiusNm: parsed.data.radiusNm, centerMode: parsed.data.center }, result);
      return c.json({ observations: result.observations, receivedAt: result.receivedAt, sources: result.sources, ...(providerFailures.length > 0 ? { providerFailures } : {}), recording: recording.status });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : "";
      if (code === "provider_adapter_not_implemented") return c.json({ error: "provider_adapter_not_implemented" }, 501);
      log("warn", "aircraft_provider_failed", { code: classifyProviderError(error), ...errorFields(error) });
      return c.json({ error: "provider_upstream_failed" }, 502);
    }
  });
  return app;
}
