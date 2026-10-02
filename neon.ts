import { defineConfig } from "@neon/config/v1";

// Declares the Neon services AIRIntel uses. Apply with `neon deploy` after `neon link`.
// - auth: Managed Better Auth (users/sessions in the `neon_auth` schema; injects NEON_AUTH_BASE_URL / NEON_AUTH_JWKS_URL)
// - functions.api: the Hono API in server/ (replaces the Supabase Edge Functions)
// No buckets are declared: AIRIntel stores no user files. The Data API stays off: the browser never queries tables.
export default defineConfig({
  auth: true,
  functions: {
    api: {
      name: "AIRIntel API",
      source: "./functions/api.ts",
      env: {
        ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? "",
        ADSB_PROVIDER: process.env.ADSB_PROVIDER ?? "",
        ADSB_API_BASE_URL: process.env.ADSB_API_BASE_URL ?? "",
        ADSB_API_KEY: process.env.ADSB_API_KEY ?? "",
      },
    },
  },
});
