import { z } from "zod";

const DEFAULT_ADSB_LOL_BASE = "https://api.adsb.lol";
const DEFAULT_ADSB_FI_BASE = "https://opendata.adsb.fi/api";
const DEFAULT_AIRPLANES_LIVE_BASE = "https://api.airplanes.live";
const NON_ICAO_TYPES = new Set(["adsb_other", "adsr_other", "tisb_other", "tisb_trackfile"]);

const altitudeValue = z.union([z.number().finite(), z.literal("ground")]).optional();

const adsbLolAircraftSchema = z
  .object({
    hex: z.string().trim().min(1),
    type: z.string().trim().toLowerCase().optional(),
    lat: z.number().finite().optional(),
    lon: z.number().finite().optional(),
    alt_baro: altitudeValue,
    alt_geom: altitudeValue,
    gs: z.number().finite().optional(),
    track: z.number().finite().optional(),
    geom_rate: z.number().finite().optional(),
    baro_rate: z.number().finite().optional(),
    squawk: z.union([z.string(), z.number()]).optional(),
    flight: z.string().optional(),
    r: z.string().optional(),
    t: z.string().optional(),
    category: z.string().optional(),
    emergency: z.string().optional(),
    seen: z.number().finite().optional(),
    seen_pos: z.number().finite().optional(),
  })
  .passthrough();

/** readsb-style radius response. adsb.lol and adsb.fi v3 / airplanes.live use `ac`; the deprecated adsb.fi v2 used `aircraft`. */
const readsbResponseSchema = z.object({
  ac: z.array(z.unknown()).optional(),
  aircraft: z.array(z.unknown()).optional(),
  now: z.number().finite().optional(),
});

/** Public, keyless readsb-compatible feeds AIRIntel can read. adsb.lol is the primary; the others are fallbacks. */
export type ReadsbProviderId = "adsb_lol" | "adsb_fi" | "airplanes_live";
export type FallbackProviderConfig = { provider: ReadsbProviderId; baseUrl: string };

export type AdsbProviderConfig = {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  /** Tried in order when the primary fails (network error, timeout, HTTP error, bad payload). */
  fallbacks?: FallbackProviderConfig[];
};

type ReadsbProviderSpec = {
  id: ReadsbProviderId;
  defaultBaseUrl: string;
  providerSchemaVersion: string;
  normalizationVersion: string;
  /** Minimum spacing between requests from this instance (documented public rate limits). */
  minIntervalMs: number;
  url: (baseUrl: string, query: { lat: number; lon: number; radiusNm: number }) => string;
};

/** Normalized live observation matching the browser `aircraftResponseSchema` contract. */
export type LiveAircraftObservation = {
  provider: string;
  providerRecordId?: string;
  icao24: string;
  registration: string | null;
  callsign: string | null;
  latitude: number;
  longitude: number;
  geometricAltitudeFt: number | null;
  barometricAltitudeFt: number | null;
  altitudeFt: number | null;
  altitudeSource: "geometric" | "barometric" | "provider" | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  verticalRateFpm: number | null;
  squawk: string | null;
  onGround: boolean | null;
  emergencyStatus: string | null;
  aircraftTypeCode: string | null;
  category: string | null;
  observedAt: string;
  receivedAt: string;
};

/** One provider that did not serve this request (machine codes only; no URLs, payloads or secrets). */
export type ProviderFailure = { provider: string; code: string; detail?: string };

export type LiveAircraftResult = {
  observations: LiveAircraftObservation[];
  receivedAt: string;
  /** The single provider that served these observations. */
  sources: string[];
  /** Providers tried before the one that served (empty when the primary answered). */
  providerFailures?: ProviderFailure[];
  /** Server-only: the provider's raw row per providerRecordId, for the flight recorder. Never sent to the browser. */
  rawByRecordId?: ReadonlyMap<string, unknown>;
};

/** Provider schema / normalization identities stored with every recorded adsb.lol observation. */
export const ADSB_LOL_PROVIDER_SCHEMA_VERSION = "adsb_lol/v2";
export const ADSB_LOL_NORMALIZATION_VERSION = "airintel-adsb-lol-normalize-2";
/** Fallback feeds share the same readsb field set and go through the same normalizer. */
export const READSB_NORMALIZATION_VERSION = "airintel-readsb-normalize-2";

const READSB_PROVIDERS: Record<ReadsbProviderId, ReadsbProviderSpec> = {
  // https://api.adsb.lol/docs — dynamic rate limits, ODbL.
  adsb_lol: {
    id: "adsb_lol", defaultBaseUrl: DEFAULT_ADSB_LOL_BASE, providerSchemaVersion: ADSB_LOL_PROVIDER_SCHEMA_VERSION, normalizationVersion: ADSB_LOL_NORMALIZATION_VERSION, minIntervalMs: 0,
    url: (base, q) => `${base}/v2/lat/${q.lat}/lon/${q.lon}/dist/${q.radiusNm}`,
  },
  // https://github.com/adsbfi/opendata — v3 radius endpoint (v2 lat/lon is deprecated), 1 req/s, personal non-commercial, cite adsb.fi.
  adsb_fi: {
    id: "adsb_fi", defaultBaseUrl: DEFAULT_ADSB_FI_BASE, providerSchemaVersion: "adsb_fi/v3", normalizationVersion: READSB_NORMALIZATION_VERSION, minIntervalMs: 1_000,
    url: (base, q) => `${base}/v3/lat/${q.lat}/lon/${q.lon}/dist/${q.radiusNm}`,
  },
  // https://airplanes.live/api-guide — /v2/point/{lat}/{lon}/{radius nm}, 1 req/s, non-commercial; may answer 403 to unknown clients.
  airplanes_live: {
    id: "airplanes_live", defaultBaseUrl: DEFAULT_AIRPLANES_LIVE_BASE, providerSchemaVersion: "airplanes_live/v2", normalizationVersion: READSB_NORMALIZATION_VERSION, minIntervalMs: 1_000,
    url: (base, q) => `${base}/v2/point/${q.lat}/${q.lon}/${q.radiusNm}`,
  },
};

const isReadsbProvider = (id: string): id is ReadsbProviderId => Object.hasOwn(READSB_PROVIDERS, id);

/** Recorder identity (schema + normalization version) for a provider AIRIntel normalizes, or null if unknown. */
export function providerRecordingIdentity(provider: string): { providerSchemaVersion: string; normalizationVersion: string } | null {
  if (!isReadsbProvider(provider)) return null;
  const spec = READSB_PROVIDERS[provider];
  return { providerSchemaVersion: spec.providerSchemaVersion, normalizationVersion: spec.normalizationVersion };
}

const DEFAULT_FALLBACKS: ReadsbProviderId[] = ["adsb_fi", "airplanes_live"];

/** ADSB_FALLBACK_PROVIDERS: comma list (adsb_fi, airplanes_live) in order; off/none disables. Unknown names are ignored. */
function resolveFallbacks(env: Record<string, string | undefined>, primary: ReadsbProviderId): FallbackProviderConfig[] {
  const raw = env.ADSB_FALLBACK_PROVIDERS?.trim().toLowerCase();
  if (raw === "off" || raw === "none" || raw === "disabled") return [];
  const names = raw ? raw.split(",").map((name) => name.trim()).filter(Boolean) : DEFAULT_FALLBACKS;
  const seen = new Set<string>([primary]);
  const out: FallbackProviderConfig[] = [];
  for (const name of names) {
    if (!isReadsbProvider(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ provider: name, baseUrl: READSB_PROVIDERS[name].defaultBaseUrl });
  }
  return out;
}

export function resolveAdsbConfig(env: Record<string, string | undefined> = process.env): AdsbProviderConfig | null {
  // Default to the documented public adsb.lol feed so same-origin Vercel previews can load live aircraft
  // without inventing data. Set ADSB_PROVIDER=off to disable the live gateway explicitly.
  const provider = (env.ADSB_PROVIDER ?? "adsb_lol").trim().toLowerCase();
  if (!provider || provider === "off" || provider === "disabled" || provider === "none") return null;

  if (provider === "adsb_lol" || provider === "adsblol") {
    const baseUrl = (env.ADSB_API_BASE_URL ?? DEFAULT_ADSB_LOL_BASE).replace(/\/+$/, "");
    return { provider: "adsb_lol", baseUrl, ...(env.ADSB_API_KEY ? { apiKey: env.ADSB_API_KEY } : {}), fallbacks: resolveFallbacks(env, "adsb_lol") };
  }

  // Keyed commercial/exchange-style adapters stay gated until their onboarding docs are complete.
  if (env.ADSB_API_BASE_URL && env.ADSB_API_KEY) {
    return { provider, baseUrl: env.ADSB_API_BASE_URL.replace(/\/+$/, ""), apiKey: env.ADSB_API_KEY };
  }

  return null;
}

function trimText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function altitudeFt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === "ground") return 0;
  return null;
}

function normalizeIcao24(hex: string): string | null {
  // readsb prefixes non-ICAO addresses with ~. Stripping it would merge a separate
  // identifier namespace into real ICAO24 records and could attach the wrong FAA owner.
  const normalized = hex.trim().toLowerCase();
  return /^[0-9a-f]{6}$/u.test(normalized) ? normalized : null;
}

function observedAtIso(nowMs: number, seenSeconds: number | undefined): string {
  const ageMs = typeof seenSeconds === "number" && Number.isFinite(seenSeconds) ? Math.max(0, seenSeconds) * 1000 : 0;
  return new Date(nowMs - ageMs).toISOString();
}

export function normalizeAdsbLolAircraft(raw: unknown, receivedAtMs: number, providerNowMs?: number): LiveAircraftObservation | null {
  return normalizeReadsbAircraft(raw, receivedAtMs, providerNowMs, "adsb_lol");
}

/** Normalizes one readsb-style `ac` row (adsb.lol, adsb.fi, airplanes.live) tagged with the provider that served it. */
export function normalizeReadsbAircraft(raw: unknown, receivedAtMs: number, providerNowMs: number | undefined, provider: ReadsbProviderId): LiveAircraftObservation | null {
  const parsed = adsbLolAircraftSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  if (row.type && NON_ICAO_TYPES.has(row.type)) return null;
  if (typeof row.lat !== "number" || typeof row.lon !== "number") return null;
  const icao24 = normalizeIcao24(row.hex);
  if (!icao24) return null;

  const barometricAltitudeFt = altitudeFt(row.alt_baro);
  const geometricAltitudeFt = altitudeFt(row.alt_geom);
  const onGround = row.alt_baro === "ground" ? true : null;
  let altitudeFtValue: number | null = null;
  let altitudeSource: LiveAircraftObservation["altitudeSource"] = null;
  if (geometricAltitudeFt != null) {
    altitudeFtValue = geometricAltitudeFt;
    altitudeSource = "geometric";
  } else if (barometricAltitudeFt != null) {
    altitudeFtValue = barometricAltitudeFt;
    altitudeSource = "barometric";
  }

  const trackDeg = typeof row.track === "number" && row.track >= 0 && row.track < 360 ? row.track : null;
  const groundSpeedKt = typeof row.gs === "number" && row.gs >= 0 ? row.gs : null;
  const verticalRateFpm =
    typeof row.geom_rate === "number" ? row.geom_rate : typeof row.baro_rate === "number" ? row.baro_rate : null;
  const nowMs = typeof providerNowMs === "number" ? providerNowMs : receivedAtMs;
  const ageSeconds = typeof row.seen_pos === "number" ? row.seen_pos : row.seen;
  const observedAt = observedAtIso(nowMs, ageSeconds);
  const receivedAt = new Date(receivedAtMs).toISOString();
  const emergency = trimText(row.emergency);

  return {
    provider,
    providerRecordId: `${icao24}:${observedAt}`,
    icao24,
    registration: trimText(row.r),
    callsign: trimText(row.flight),
    latitude: row.lat,
    longitude: row.lon,
    geometricAltitudeFt,
    barometricAltitudeFt,
    altitudeFt: altitudeFtValue,
    altitudeSource,
    groundSpeedKt,
    trackDeg,
    verticalRateFpm,
    squawk: trimText(row.squawk),
    onGround,
    emergencyStatus: emergency && emergency.toLowerCase() !== "none" ? emergency : null,
    aircraftTypeCode: trimText(row.t),
    category: trimText(row.category),
    observedAt,
    receivedAt,
  };
}

export type ProviderFetchOptions = {
  /** Per-attempt timeout for the primary provider (default 12 s). */
  timeoutMs?: number;
  /** Extra primary attempts after a transient failure (network error, 429, 5xx). Default 1. Fallbacks never retry. */
  retries?: number;
  /** Backoff base in ms; attempt n waits base * 2^n (+ jitter), capped. Default 300. */
  backoffMs?: number;
  /** Timeout for each fallback provider (default 8 s), also capped by what is left of `budgetMs`. */
  fallbackTimeoutMs?: number;
  /** Total wall-clock budget for the whole chain. A fallback is not started with less than 1.5 s left. Default unbounded. */
  budgetMs?: number;
  /** Providers that already failed earlier in this run (e.g. one sweep); they are skipped unless every provider is. */
  skipProviders?: ReadonlySet<string>;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isTransientStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;
const PRIMARY_TIMEOUT_MS = 12_000;
const FALLBACK_TIMEOUT_MS = 8_000;
const MIN_FALLBACK_MS = 1_500;
const USER_AGENT = "AIRIntel/0.1 (+https://github.com/immahugeduck/AIRintel)";

/** Per-instance spacing for rate-limited public feeds (serverless instances do not share it; the sweep is sequential). */
const lastRequestAt = new Map<string, number>();
/** Test hook. */
export function resetProviderThrottle(): void { lastRequestAt.clear(); }

/** Thrown when every provider in the chain failed. `code` and classification follow the primary's failure. */
export class ProviderChainError extends Error {
  readonly failures: ProviderFailure[];
  readonly primary: unknown;
  readonly code: string;
  constructor(failures: ProviderFailure[], primary: unknown, primaryProvider: string) {
    super(`all_providers_failed ${failures.map((f) => `${f.provider}=${f.code}${f.detail ? `(${f.detail})` : ""}`).join("; ")}`);
    this.name = "ProviderChainError";
    this.failures = failures;
    this.primary = primary;
    const code = primary && typeof primary === "object" && "code" in primary ? (primary as { code?: unknown }).code : undefined;
    this.code = typeof code === "string" ? code : `${primaryProvider}_${classifyProviderError(primary).replace(/^provider_/, "")}`;
  }
}

/** Stable machine code for a provider failure (also used by the sweep summary). */
export function classifyProviderError(error: unknown): string {
  if (error instanceof ProviderChainError) return classifyProviderError(error.primary);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return "provider_invalid_payload";
  const name = error && typeof error === "object" && "name" in error ? String((error as { name?: unknown }).name) : "";
  if (name === "TimeoutError" || name === "AbortError") return "provider_timeout";
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  if (code === "provider_adapter_not_implemented") return code;
  if (/_upstream_\d{3}$/.test(code)) return "provider_upstream_failed";
  return "provider_network_error";
}

/** Short, secret-free detail: HTTP status, or the transport cause code (e.g. UND_ERR_CONNECT_TIMEOUT, ENOTFOUND). */
function failureDetail(error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  const status = /_upstream_(\d{3})$/.exec(code);
  if (status) return status[1];
  const cause = error && typeof error === "object" && "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  if (cause && typeof cause === "object") {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string" && /^[A-Z0-9_]{2,40}$/.test(causeCode)) return causeCode;
    const causeName = (cause as { name?: unknown }).name;
    if (typeof causeName === "string" && /^[A-Za-z]{2,40}$/.test(causeName)) return causeName;
  }
  return undefined;
}

function toFailure(provider: string, error: unknown): ProviderFailure {
  const detail = failureDetail(error);
  return { provider, code: classifyProviderError(error), ...(detail ? { detail } : {}) };
}

async function fetchReadsb(
  spec: ReadsbProviderSpec,
  baseUrl: string,
  apiKey: string | undefined,
  query: { lat: number; lon: number; radiusNm: number },
  fetchImpl: typeof fetch,
  attempt: { timeoutMs: number; retries: number; backoffMs: number; sleep: (ms: number) => Promise<void> },
): Promise<LiveAircraftResult> {
  const radiusNm = Math.min(250, Math.max(1, query.radiusNm));
  const url = new URL(spec.url(baseUrl.replace(/\/+$/, ""), { lat: query.lat, lon: query.lon, radiusNm }));
  // adsb.lol rejects clients that omit User-Agent (Node's undici default). Identify AIRIntel explicitly.
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": USER_AGENT };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response: Response | null = null;
  for (let n = 0; ; n += 1) {
    let failure: Error | null = null;
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(attempt.timeoutMs) });
      if (response.ok) break;
      failure = Object.assign(new Error(`${spec.id}_upstream_${response.status}`), { code: `${spec.id}_upstream_${response.status}` });
      if (!isTransientStatus(response.status)) throw failure;
    } catch (error) {
      if (failure && error === failure) throw failure; // non-transient HTTP status: do not retry
      failure = error instanceof Error ? error : new Error(`${spec.id}_network_error`);
      if (!(failure as { code?: unknown }).code) {
        try { (failure as { code?: string }).code = `${spec.id}_network_error`; } catch { /* read-only code (DOMException) */ }
      }
    }
    if (n >= attempt.retries) throw failure;
    const retryAfter = Number(response?.headers.get("retry-after"));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(2_000, retryAfter * 1000) : Math.min(2_000, attempt.backoffMs * 2 ** n + Math.floor(Math.random() * 100));
    await attempt.sleep(backoff);
  }
  if (!response) throw new Error(`${spec.id}_network_error`);

  const payload = readsbResponseSchema.parse(await response.json());
  const receivedAtMs = Date.now();
  // adsb.lol, adsb.fi v3 and airplanes.live send epoch ms; the deprecated adsb.fi v2 sent epoch seconds.
  const providerNowMs = typeof payload.now === "number" ? (payload.now < 1e11 ? payload.now * 1000 : payload.now) : receivedAtMs;
  const observations: LiveAircraftObservation[] = [];
  const rawByRecordId = new Map<string, unknown>();
  for (const row of payload.ac ?? payload.aircraft ?? []) {
    const observation = normalizeReadsbAircraft(row, receivedAtMs, providerNowMs, spec.id);
    if (observation) {
      observations.push(observation);
      if (observation.providerRecordId) rawByRecordId.set(observation.providerRecordId, row);
    }
  }

  return { observations, receivedAt: new Date(receivedAtMs).toISOString(), sources: [spec.id], providerFailures: [], rawByRecordId };
}

export async function fetchAdsbLolNearby(
  config: AdsbProviderConfig,
  query: { lat: number; lon: number; radiusNm: number },
  fetchImpl: typeof fetch = fetch,
  options: ProviderFetchOptions = {},
): Promise<LiveAircraftResult> {
  return fetchReadsb(READSB_PROVIDERS.adsb_lol, config.baseUrl, config.apiKey, query, fetchImpl, {
    timeoutMs: options.timeoutMs ?? PRIMARY_TIMEOUT_MS,
    retries: Math.max(0, options.retries ?? 1),
    backoffMs: options.backoffMs ?? 300,
    sleep: options.sleep ?? defaultSleep,
  });
}

/**
 * Live aircraft near a point: the configured primary (adsb.lol), then each fallback in order. Every observation carries
 * the provider that actually served it; `providerFailures` lists the ones that did not. When all fail the thrown
 * ProviderChainError lists each provider's failure. Without fallbacks the primary's own error is thrown unchanged.
 */
export async function fetchLiveAircraft(
  config: AdsbProviderConfig,
  query: { lat: number; lon: number; radiusNm: number },
  fetchImpl: typeof fetch = fetch,
  options: ProviderFetchOptions = {},
): Promise<LiveAircraftResult> {
  // Other provider identities require a dedicated adapter after docs/provider-onboarding.md is completed.
  if (!isReadsbProvider(config.provider)) throw Object.assign(new Error("provider_adapter_not_implemented"), { code: "provider_adapter_not_implemented" as const });
  const fallbacks = config.fallbacks ?? [];
  if (fallbacks.length === 0) return fetchAdsbLolNearby(config, query, fetchImpl, options);

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const started = now();
  const budgetMs = options.budgetMs ?? Number.POSITIVE_INFINITY;
  const remaining = () => budgetMs - (now() - started);
  const chain = [{ provider: config.provider, baseUrl: config.baseUrl, apiKey: config.apiKey }, ...fallbacks.map((f) => ({ ...f, apiKey: undefined }))];
  const skip = options.skipProviders;
  const skipAll = !!skip && chain.every((entry) => skip.has(entry.provider));
  const failures: ProviderFailure[] = [];
  let primaryError: unknown = null;
  let tried = 0;

  for (const [index, entry] of chain.entries()) {
    const spec = READSB_PROVIDERS[entry.provider];
    if (!skipAll && skip?.has(entry.provider)) { failures.push({ provider: entry.provider, code: "provider_skipped", detail: "failed_earlier_in_run" }); continue; }
    const isFirst = tried === 0;
    if (!isFirst && remaining() < MIN_FALLBACK_MS) { failures.push({ provider: entry.provider, code: "provider_budget_exhausted" }); continue; }
    if (spec.minIntervalMs > 0) {
      const wait = (lastRequestAt.get(spec.id) ?? Number.NEGATIVE_INFINITY) + spec.minIntervalMs - now();
      if (wait > 0) {
        if (wait > remaining() - MIN_FALLBACK_MS) { failures.push({ provider: entry.provider, code: "provider_budget_exhausted", detail: "rate_limit_wait" }); continue; }
        await sleep(wait);
      }
      lastRequestAt.set(spec.id, now());
    }
    tried += 1;
    const cap = Number.isFinite(remaining()) ? Math.max(1_000, remaining()) : Number.POSITIVE_INFINITY;
    const timeoutMs = Math.min(index === 0 ? options.timeoutMs ?? PRIMARY_TIMEOUT_MS : options.fallbackTimeoutMs ?? FALLBACK_TIMEOUT_MS, cap);
    try {
      const result = await fetchReadsb(spec, entry.baseUrl, entry.apiKey, query, fetchImpl, {
        timeoutMs,
        retries: index === 0 ? Math.max(0, options.retries ?? 1) : 0,
        backoffMs: options.backoffMs ?? 300,
        sleep,
      });
      return { ...result, providerFailures: failures };
    } catch (error) {
      if (primaryError === null) primaryError = error;
      failures.push(toFailure(entry.provider, error));
    }
  }
  throw new ProviderChainError(failures, primaryError, config.provider);
}

export { DEFAULT_ADSB_LOL_BASE };
