import { createApp } from "./app";
import { createJwtVerifier } from "./auth";
import { readConfig } from "./config";
import { createPool } from "./db";

const config = readConfig();

export const app = createApp({
  db: config.databaseUrl ? createPool(config.databaseUrl) : null,
  verifier: config.neonAuthBaseUrl ? createJwtVerifier({ baseUrl: config.neonAuthBaseUrl, ...(config.neonAuthJwksUrl ? { jwksUrl: config.neonAuthJwksUrl } : {}) }) : null,
  allowedOrigins: config.allowedOrigins,
  adsbConfigured: config.adsbConfigured,
});
