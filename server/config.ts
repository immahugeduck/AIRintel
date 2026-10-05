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
 * Reads server configuration from the environment.
 * On Neon Functions DATABASE_URL, NEON_AUTH_BASE_URL and NEON_AUTH_JWKS_URL are injected automatically.
 */
export function readConfig(env: Env = process.env): ServerConfig {
  const allowedOrigins = new Set(
    [...(env.ALLOWED_ORIGINS ?? "").split(","), ...vercelOrigins(env)]
      .map((value) => value.trim())
      .filter(Boolean),
  );

  return {
    databaseUrl: env.DATABASE_URL || undefined,
    neonAuthBaseUrl: env.NEON_AUTH_BASE_URL || undefined,
    neonAuthJwksUrl: env.NEON_AUTH_JWKS_URL || (env.NEON_AUTH_BASE_URL ? `${env.NEON_AUTH_BASE_URL.replace(/\/+$/, "")}/.well-known/jwks.json` : undefined),
    allowedOrigins,
    adsb: resolveAdsbConfig(env),
  };
}
