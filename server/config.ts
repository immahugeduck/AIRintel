export type ServerConfig = {
  databaseUrl: string | undefined;
  neonAuthBaseUrl: string | undefined;
  neonAuthJwksUrl: string | undefined;
  allowedOrigins: Set<string>;
  adsbConfigured: boolean;
};

type Env = Record<string, string | undefined>;

/**
 * Reads server configuration from the environment.
 * On Neon Functions DATABASE_URL, NEON_AUTH_BASE_URL and NEON_AUTH_JWKS_URL are injected automatically.
 */
export function readConfig(env: Env = process.env): ServerConfig {
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    neonAuthBaseUrl: env.NEON_AUTH_BASE_URL || undefined,
    neonAuthJwksUrl: env.NEON_AUTH_JWKS_URL || (env.NEON_AUTH_BASE_URL ? `${env.NEON_AUTH_BASE_URL.replace(/\/+$/, "")}/.well-known/jwks.json` : undefined),
    allowedOrigins: new Set((env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean)),
    adsbConfigured: Boolean(env.ADSB_PROVIDER && env.ADSB_API_BASE_URL && env.ADSB_API_KEY),
  };
}
