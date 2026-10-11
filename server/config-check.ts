export {};
// `npm run env:check` - validates the server environment (reads .env.local / .env, never prints secret values).
for (const file of [".env.local", ".env"]) {
  try { process.loadEnvFile(file); } catch { /* not present */ }
}
const { readConfig } = await import("./config.js");
const config = readConfig();
const lines = config.issues.map((issue) => `${issue.level.toUpperCase().padEnd(7)} ${issue.variable}: ${issue.message}`);
const status = (value: unknown) => (value ? "set" : "missing");
console.log(`DATABASE_URL        ${status(config.databaseUrl)}`);
console.log(`NEON_AUTH_BASE_URL  ${status(config.neonAuthBaseUrl)}`);
console.log(`CRON_SECRET         ${status(config.cronSecret)} (sweep endpoint ${config.cronSecret ? "enabled" : "DISABLED - fails closed"})`);
console.log(`ADSB provider       ${config.adsb ? config.adsb.provider : "off"}`);
console.log(`NET_RETENTION_DAYS  ${config.net.retentionDays ?? "unset (nothing is ever deleted automatically)"}`);
if (lines.length > 0) console.log(`\n${lines.join("\n")}`);
const errors = config.issues.filter((issue) => issue.level === "error").length;
const missingSecret = !config.cronSecret;
if (errors > 0 || missingSecret) {
  console.log(missingSecret && errors === 0 ? "\nCRON_SECRET is not set: the always-on net cannot run." : `\n${errors} error(s) found.`);
  process.exit(1);
}
console.log("\nEnvironment looks good.");
