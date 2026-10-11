/**
 * Structured (one JSON object per line) server logging for Vercel/Node log drains.
 * Callers pass machine-readable fields only: never user ids, e-mail addresses, coordinates, tokens or provider payloads.
 * `errorFields` reduces an unknown error to a name/code plus a short, scrubbed message (no stack traces).
 */
export type LogLevel = "info" | "warn" | "error";
type Fields = Record<string, string | number | boolean | null | undefined>;

let sink: (line: string) => void = (line) => { process.stdout.write(`${line}\n`); };
/** Test hook: capture log lines. Returns a restore function. */
export function setLogSink(next: (line: string) => void): () => void {
  const previous = sink;
  sink = next;
  return () => { sink = previous; };
}

export function log(level: LogLevel, event: string, fields: Fields = {}): void {
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) entry[key] = value;
  try { sink(JSON.stringify(entry)); } catch { /* logging must never throw */ }
}

const SECRET_PATTERNS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, // URLs / connection strings (may embed credentials)
  /\bBearer\s+\S+/gi,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, // JWTs
  /\b(?:sk|pk|rk|ghp|gho|vercel_blob_rw)_[\w-]{8,}/gi,
];

export function scrub(text: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[redacted]"), text).slice(0, 200);
}

export function errorFields(error: unknown): Fields {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { errorName: error.name, ...(typeof code === "string" || typeof code === "number" ? { errorCode: String(code) } : {}), errorMessage: scrub(error.message) };
  }
  return { errorName: typeof error };
}
