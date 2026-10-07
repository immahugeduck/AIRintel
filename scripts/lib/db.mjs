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
  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Set DATABASE_URL (or DATABASE_URL_UNPOOLED) to your Neon connection string. See README 'Set up Neon'.");
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}
