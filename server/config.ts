import { resolveAdsbConfig, type AdsbProviderConfig } from "./providers/adsb.js";

/** Always-on net (sweep) tuning. All server-side; see docs/netted-aircraft.md. */
export type NetConfig = {
  /** Max distinct provider queries per sweep (areas merged first). */
  maxAreas: number;
  /** Provider query radius = area radius x this factor (capped at 50 NM) so entries and exits are observed. */
  marginFactor: number;
  /** An area is skipped if it was polled more recently than this. */
  minIntervalSeconds: number;
  /** Stop starting new provider queries after this many ms (keeps the run inside the function limit). */
  budgetMs: number;
  /** Delete raw observations older than this many days. Undefined = never delete automatically. */
  retentionDays: number | undefined;
};

export type ServerConfig = {
  databaseUrl: string | undefined;
  neonAuthBaseUrl: string | undefined;
  neonAuthJwksUrl: string | undefined;
  allowedOrigins: Set<string>;
  adsb: AdsbProviderConfig | null;
  /** Bearer secret for /api/net/sweep. Undefined makes the endpoint fail closed (503). */
  cronSecret: string | undefined;
  net: NetConfig;
  /** Human-readable problems found while reading the environment (never contains secret values). */
  issues: ConfigIssue[];
};

export type ConfigIssue = { level: "error" | "warning"; variable: string; message: string };

export const MIN_CRON_SECRET_LENGTH = 24;

type Env = Record<string, string | undefined>;

/** Collect browser origins Vercel injects so preview deployments work without hand-editing ALLOWED_ORIGINS. */
function vercelOrigins(env: Env): string[] {
  const origins: string[] = [];
  for (const key of ["VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_BRANCH_URL", "VERCEL_URL"] as const) {
    const host = env[key]?.trim();
    if (!host) continue;
    origins.push(host.startsWith("http") ? host.replace(/\/+$/, "") : `https://${host.replace(/\/+$/, "")}`);
  }
  return origins;
}

/**
 * Prefix the Vercel Neon integration (the "SERVERSIDE_NEON" connection) puts on the variables it injects,
 * e.g. SERVERSIDE_NEON_NEON_AUTH_BASE_URL. Used only as a fallback when the plain names are unset.
 */
export const VERCEL_NEON_ENV_PREFIX = "SERVERSIDE_NEON_";

const nonEmpty = (value: string | undefined) => value?.trim() || undefined;
const jwksFromBase = (baseUrl: string) => `${baseUrl.replace(/\/+$/, "")}/.well-known/jwks.json`;

/**
 * Neon Auth URLs. The plain NEON_AUTH_* names win; when NEON_AUTH_BASE_URL is unset the SERVERSIDE_NEON_-prefixed
 * names written by the Vercel Neon integration are used. The JWKS URL always comes from the same source as the base URL.
 */
function resolveNeonAuth(env: Env): { baseUrl: string | undefined; jwksUrl: string | undefined } {
  const plainBase = nonEmpty(env.NEON_AUTH_BASE_URL);
  const plainJwks = nonEmpty(env.NEON_AUTH_JWKS_URL);
  if (plainBase) return { baseUrl: plainBase, jwksUrl: plainJwks ?? jwksFromBase(plainBase) };

  const prefixedBase = nonEmpty(env[`${VERCEL_NEON_ENV_PREFIX}NEON_AUTH_BASE_URL`]);
  if (prefixedBase) {
    const prefixedJwks = nonEmpty(env[`${VERCEL_NEON_ENV_PREFIX}NEON_AUTH_JWKS_URL`]);
    return { baseUrl: prefixedBase, jwksUrl: prefixedJwks ?? jwksFromBase(prefixedBase) };
  }

  return { baseUrl: undefined, jwksUrl: plainJwks };
}

/**
 * Database URL. Access grants are keyed by the Neon Auth user id, so the database must be the one that hosts
 * that Neon Auth instance. When sign-in comes from the SERVERSIDE_NEON_ connection (plain NEON_AUTH_BASE_URL unset)
 * and that connection also provides a database URL, use it; otherwise fall back to the plain DATABASE_URL.
 */
function resolveDatabaseUrl(env: Env): string | undefined {
  const prefixedDb = nonEmpty(env[`${VERCEL_NEON_ENV_PREFIX}DATABASE_URL`]);
  const authIsPrefixed = !nonEmpty(env.NEON_AUTH_BASE_URL) && Boolean(nonEmpty(env[`${VERCEL_NEON_ENV_PREFIX}NEON_AUTH_BASE_URL`]));
  if (authIsPrefixed && prefixedDb) return prefixedDb;
  return nonEmpty(env.DATABASE_URL) ?? prefixedDb;
}

/**
 * Reads server configuration from the environment.
 * On Neon Functions DATABASE_URL, NEON_AUTH_BASE_URL and NEON_AUTH_JWKS_URL are injected automatically.
 * On Vercel the Neon integration injects SERVERSIDE_NEON_NEON_AUTH_BASE_URL, which is used when the plain name is unset.
 */
function integerEnv(env: Env, name: string, fallback: number, range: { min: number; max: number }, issues: ConfigIssue[]): number {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    issues.push({ level: "error", variable: name, message: `${name} must be a whole number between ${range.min} and ${range.max}; using the default ${fallback}.` });
    return fallback;
  }
  return value;
}

export function readConfig(env: Env = process.env): ServerConfig {
  const issues: ConfigIssue[] = [];
  const allowedOrigins = new Set(
    [...(env.ALLOWED_ORIGINS ?? "").split(","), ...vercelOrigins(env)]
      .map((value) => value.trim())
      .filter(Boolean),
  );

  const neonAuth = resolveNeonAuth(env);

  const cronSecret = nonEmpty(env.CRON_SECRET);
  if (cronSecret && cronSecret.length < MIN_CRON_SECRET_LENGTH) {
    issues.push({ level: "error", variable: "CRON_SECRET", message: `CRON_SECRET is too short (minimum ${MIN_CRON_SECRET_LENGTH} characters). The sweep endpoint stays disabled until it is long and random, e.g. \`openssl rand -hex 32\`.` });
  }
  const marginRaw = nonEmpty(env.NET_SWEEP_MARGIN_FACTOR);
  let marginFactor = 2;
  if (marginRaw !== undefined) {
    const parsed = Number(marginRaw);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 3) marginFactor = parsed;
    else issues.push({ level: "error", variable: "NET_SWEEP_MARGIN_FACTOR", message: "NET_SWEEP_MARGIN_FACTOR must be a number between 1 and 3; using the default 2." });
  }
  const retentionRaw = nonEmpty(env.NET_RETENTION_DAYS);
  const retentionDays = retentionRaw === undefined ? undefined : integerEnv(env, "NET_RETENTION_DAYS", 0, { min: 7, max: 3650 }, issues) || undefined;
  const net: NetConfig = {
    maxAreas: integerEnv(env, "NET_SWEEP_MAX_AREAS", 25, { min: 1, max: 100 }, issues),
    marginFactor,
    minIntervalSeconds: integerEnv(env, "NET_SWEEP_MIN_INTERVAL_SECONDS", 30, { min: 0, max: 3600 }, issues),
    budgetMs: integerEnv(env, "NET_SWEEP_BUDGET_MS", 40_000, { min: 2_000, max: 45_000 }, issues),
    retentionDays,
  };

  const databaseUrl = resolveDatabaseUrl(env);
  if (!databaseUrl) issues.push({ level: "warning", variable: "DATABASE_URL", message: "DATABASE_URL is not set: history, the netted log, the net and evidence uploads answer 503 until it is configured." });
  if (!neonAuth.baseUrl) issues.push({ level: "warning", variable: "NEON_AUTH_BASE_URL", message: "NEON_AUTH_BASE_URL is not set: signed-in routes answer 503 until Neon Auth is configured." });
  if (env.VERCEL && env.ALLOWED_ORIGINS === undefined && allowedOrigins.size === 0) issues.push({ level: "warning", variable: "ALLOWED_ORIGINS", message: "ALLOWED_ORIGINS is empty and no Vercel URL variables were found; only same-origin browser calls will be accepted." });
  for (const name of Object.keys(env)) {
    if (name.startsWith("VITE_") && /(SECRET|PRIVATE|SERVICE_ROLE|DATABASE_URL|CRON)/i.test(name) && nonEmpty(env[name])) {
      issues.push({ level: "error", variable: name, message: `${name} starts with VITE_ and would be bundled into the browser. Never put secrets in VITE_* variables; rename it without the prefix.` });
    }
  }

  return {
    databaseUrl,
    neonAuthBaseUrl: neonAuth.baseUrl,
    neonAuthJwksUrl: neonAuth.jwksUrl,
    allowedOrigins,
    adsb: resolveAdsbConfig(env),
    cronSecret: cronSecret && cronSecret.length >= MIN_CRON_SECRET_LENGTH ? cronSecret : undefined,
    net,
    issues,
  };
}
