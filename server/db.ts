import pg from "pg";

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
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 5, statement_timeout: QUERY_TIMEOUT_MS, idleTimeoutMillis: 30_000 });
  // Neon scales to zero and the pooler reclaims idle clients; pg emits an error on the pool for those.
  // The pool has already discarded the dead client, so log and carry on instead of crashing the process.
  pool.on("error", (error) => console.warn("[db] idle client error:", error.message));
  return pool;
}

export const iso = (value: Date | string | null): string | null => (value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString());
