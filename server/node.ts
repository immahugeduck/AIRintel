// Local / container entry: `npm run api:dev`. Not used by Neon Functions (they load functions/api.ts).
import { serve } from "@hono/node-server";

for (const file of [".env.local", ".env"]) {
  try { process.loadEnvFile(file); } catch { /* file not present */ }
}
// Import after the env files are loaded: server/index.ts reads configuration at module load.
const { app } = await import("./index");

const port = Number(process.env.API_PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => console.log(`AIRIntel API listening on http://localhost:${info.port}`));
