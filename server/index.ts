import { createApp } from "./app.js";
import { createJwtVerifier } from "./auth.js";
import { readConfig } from "./config.js";
import { createPool } from "./db.js";

const config = readConfig();

export const app = createApp({
  db: config.databaseUrl ? createPool(config.databaseUrl) : null,
  verifier: config.neonAuthBaseUrl ? createJwtVerifier({ baseUrl: config.neonAuthBaseUrl, ...(config.neonAuthJwksUrl ? { jwksUrl: config.neonAuthJwksUrl } : {}) }) : null,
  allowedOrigins: config.allowedOrigins,
  adsbConfigured: config.adsbConfigured,
});
