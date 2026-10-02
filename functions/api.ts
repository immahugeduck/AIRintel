// Neon Function entry point: `neon deploy` bundles this file (see neon.ts).
// DATABASE_URL, NEON_AUTH_BASE_URL and NEON_AUTH_JWKS_URL are injected by Neon at runtime.
import { app } from "../server/index";

export default app;
