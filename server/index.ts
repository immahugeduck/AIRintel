import { createApp } from "./app.js";
import { createJwtVerifier } from "./auth.js";
import { readConfig } from "./config.js";
import { createPool } from "./db.js";
import { log } from "./logger.js";

const config = readConfig();

for (const issue of config.issues) log(issue.level === "error" ? "error" : "warn", "config_issue", { variable: issue.variable, message: issue.message });

export const app = createApp({
  db: config.databaseUrl ? createPool(config.databaseUrl) : null,
  verifier: config.neonAuthBaseUrl ? createJwtVerifier({ baseUrl: config.neonAuthBaseUrl, ...(config.neonAuthJwksUrl ? { jwksUrl: config.neonAuthJwksUrl } : {}) }) : null,
  allowedOrigins: config.allowedOrigins,
  adsb: config.adsb,
  cronSecret: config.cronSecret,
  net: config.net,
  configIssues: config.issues,
});
