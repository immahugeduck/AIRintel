import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "../http";

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radiusNm: z.coerce.number().positive().max(100),
});

/** Live-aircraft gateway. The provider adapter stays unimplemented until docs/provider-onboarding.md is complete. */
export function aircraftRoutes(options: { providerConfigured: boolean }) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.get("/", (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_spatial_query" }, 400);
    if (!options.providerConfigured) return c.json({ error: "provider_not_configured" }, 503);
    // A provider implementation is intentionally absent until its documented contract,
    // units, licensing, limits, and authentication method pass the onboarding gate.
    return c.json({ error: "provider_adapter_not_implemented" }, 501);
  });
  return app;
}
