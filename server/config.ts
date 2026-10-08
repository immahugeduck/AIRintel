import { resolveAdsbConfig, type AdsbProviderConfig } from "./providers/adsb.js";

export type ServerConfig = {
  databaseUrl: string | undefined;
  neonAuthBaseUrl: string | undefined;
  neonAuthJwksUrl: string | undefined;
  allowedOrigins: Set<string>;
  adsb: AdsbProviderConfig | null;
};

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
 * Reads server configuration from the environment.
 * On Neon Functions DATABASE_URL, NEON_AUTH_BASE_URL and NEON_AUTH_JWKS_URL are injected automatically.
 * On Vercel the Neon integration injects SERVERSIDE_NEON_NEON_AUTH_BASE_URL, which is used when the plain name is unset.
 */
export function readConfig(env: Env = process.env): ServerConfig {
  const allowedOrigins = new Set(
    [...(env.ALLOWED_ORIGINS ?? "").split(","), ...vercelOrigins(env)]
      .map((value) => value.trim())
      .filter(Boolean),
  );

  const neonAuth = resolveNeonAuth(env);

  return {
    databaseUrl: env.DATABASE_URL || undefined,
    neonAuthBaseUrl: neonAuth.baseUrl,
    neonAuthJwksUrl: neonAuth.jwksUrl,
    allowedOrigins,
    adsb: resolveAdsbConfig(env),
  };
}
