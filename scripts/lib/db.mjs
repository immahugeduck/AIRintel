import pg from "pg";

/** Loads .env.local / .env (if present) without overriding variables that are already set. */
export function loadEnvFiles() {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

/** Migrations and admin scripts prefer the direct (unpooled) connection string. */
export async function connect() {
  loadEnvFiles();
  // Keep scripts on the same database as the API: when sign-in uses the SERVERSIDE_NEON_ connection, so does the data.
  const env = process.env;
  const prefixed = !env.NEON_AUTH_BASE_URL?.trim() && env.SERVERSIDE_NEON_NEON_AUTH_BASE_URL?.trim()
    && (env.SERVERSIDE_NEON_DATABASE_URL_UNPOOLED || env.SERVERSIDE_NEON_DATABASE_URL);
  const connectionString = prefixed || env.DATABASE_URL_UNPOOLED || env.DATABASE_URL
    || env.SERVERSIDE_NEON_DATABASE_URL_UNPOOLED || env.SERVERSIDE_NEON_DATABASE_URL;
  if (!connectionString) {
    throw new Error("Set DATABASE_URL (or DATABASE_URL_UNPOOLED) to your Neon connection string. See README 'Set up Neon'.");
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}
