import pg from "pg";
import { errorFields, log } from "./logger.js";

/** Minimal query surface used by the API; lets tests supply a real or in-memory implementation. */
export interface Queryable {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

export const QUERY_TIMEOUT_MS = 8_000;

/**
 * Creates the shared connection pool. Use the pooled Neon `DATABASE_URL`.
 * The pool is created once per process (Neon Function isolate or Node server)
 * and reused across requests, which is what Neon recommends for long-running compute.
 */
/**
 * pg currently treats sslmode=prefer|require|verify-ca as verify-full and logs a SECURITY WARNING on every
 * cold start (pg v9 will switch them to weaker libpq semantics). Pin verify-full explicitly so behavior
 * stays strict across the upgrade and the warning stops. Strings that already opt into libpq compat are left alone.
 */
export function normalizeSslMode(connectionString: string): string {
  if (/[?&]uselibpqcompat=true/i.test(connectionString)) return connectionString;
  return connectionString.replace(/([?&]sslmode=)(prefer|require|verify-ca)(?=&|$)/i, "$1verify-full");
}

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: normalizeSslMode(connectionString), max: process.env.VERCEL ? 3 : 5, statement_timeout: QUERY_TIMEOUT_MS, idleTimeoutMillis: 30_000 });
  // Neon scales to zero and the pooler reclaims idle clients; pg emits an error on the pool for those.
  // The pool has already discarded the dead client, so log and carry on instead of crashing the process.
  pool.on("error", (error) => log("warn", "db_idle_client_error", errorFields(error)));
  return pool;
}

export const iso = (value: Date | string | null): string | null => (value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString());
