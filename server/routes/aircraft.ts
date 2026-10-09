import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "../http.js";
import { recordLiveObservations, type LiveRecordingDeps } from "../live-recording.js";
import { fetchLiveAircraft, type AdsbProviderConfig } from "../providers/adsb.js";

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radiusNm: z.coerce.number().positive().max(100),
});

/** Live-aircraft gateway. Providers are gated by docs/provider-onboarding.md and ADSB_* env. */
export function aircraftRoutes(options: { adsb: AdsbProviderConfig | null; recording?: LiveRecordingDeps | null }) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.get("/", async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_spatial_query" }, 400);
    if (!options.adsb) return c.json({ error: "provider_not_configured" }, 503);
    try {
      const result = await fetchLiveAircraft(options.adsb, parsed.data);
      // Signed-in users with the history grant contribute these real observations to the flight recorder.
      const recording = await recordLiveObservations(options.recording ?? null, c.req.header("authorization"), parsed.data.radiusNm, result);
      return c.json({ observations: result.observations, receivedAt: result.receivedAt, sources: result.sources, recording: recording.status });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : "";
      if (code === "provider_adapter_not_implemented") return c.json({ error: "provider_adapter_not_implemented" }, 501);
      return c.json({ error: "provider_upstream_failed" }, 502);
    }
  });
  return app;
}
