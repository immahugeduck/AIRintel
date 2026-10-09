import { z } from "zod";

const DEFAULT_ADSB_LOL_BASE = "https://api.adsb.lol";

const altitudeValue = z.union([z.number().finite(), z.literal("ground")]).optional();

const adsbLolAircraftSchema = z
  .object({
    hex: z.string().trim().min(1),
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

const adsbLolResponseSchema = z.object({
  ac: z.array(z.unknown()).optional(),
  now: z.number().finite().optional(),
});

export type AdsbProviderConfig = {
  provider: string;
  baseUrl: string;
  apiKey?: string;
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

export type LiveAircraftResult = {
  observations: LiveAircraftObservation[];
  receivedAt: string;
  sources: string[];
  /** Server-only: the provider's raw row per providerRecordId, for the flight recorder. Never sent to the browser. */
  rawByRecordId?: ReadonlyMap<string, unknown>;
};

/** Provider schema / normalization identities stored with every recorded adsb.lol observation. */
export const ADSB_LOL_PROVIDER_SCHEMA_VERSION = "adsb_lol/v2";
export const ADSB_LOL_NORMALIZATION_VERSION = "airintel-adsb-lol-normalize-1";

export function resolveAdsbConfig(env: Record<string, string | undefined> = process.env): AdsbProviderConfig | null {
  // Default to the documented public adsb.lol feed so same-origin Vercel previews can load live aircraft
  // without inventing data. Set ADSB_PROVIDER=off to disable the live gateway explicitly.
  const provider = (env.ADSB_PROVIDER ?? "adsb_lol").trim().toLowerCase();
  if (!provider || provider === "off" || provider === "disabled" || provider === "none") return null;

  if (provider === "adsb_lol" || provider === "adsblol") {
    const baseUrl = (env.ADSB_API_BASE_URL ?? DEFAULT_ADSB_LOL_BASE).replace(/\/+$/, "");
    return { provider: "adsb_lol", baseUrl, ...(env.ADSB_API_KEY ? { apiKey: env.ADSB_API_KEY } : {}) };
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
  const normalized = hex.trim().toLowerCase().replace(/^~/u, "");
  return /^[0-9a-f]{6}$/u.test(normalized) ? normalized : null;
}

function observedAtIso(nowMs: number, seenSeconds: number | undefined): string {
  const ageMs = typeof seenSeconds === "number" && Number.isFinite(seenSeconds) ? Math.max(0, seenSeconds) * 1000 : 0;
  return new Date(nowMs - ageMs).toISOString();
}

export function normalizeAdsbLolAircraft(raw: unknown, receivedAtMs: number, providerNowMs?: number): LiveAircraftObservation | null {
  const parsed = adsbLolAircraftSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
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
    provider: "adsb_lol",
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

export async function fetchAdsbLolNearby(
  config: AdsbProviderConfig,
  query: { lat: number; lon: number; radiusNm: number },
  fetchImpl: typeof fetch = fetch,
): Promise<LiveAircraftResult> {
  const radiusNm = Math.min(250, Math.max(1, query.radiusNm));
  const url = new URL(`${config.baseUrl}/v2/lat/${query.lat}/lon/${query.lon}/dist/${radiusNm}`);
  // adsb.lol rejects clients that omit User-Agent (Node's undici default). Identify AIRIntel explicitly.
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "AIRIntel/0.1 (+https://github.com/immahugeduck/AIRintel)",
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`adsb_lol_upstream_${response.status}`);

  const payload = adsbLolResponseSchema.parse(await response.json());
  const receivedAtMs = Date.now();
  const providerNowMs = typeof payload.now === "number" ? payload.now : receivedAtMs;
  const observations: LiveAircraftObservation[] = [];
  const rawByRecordId = new Map<string, unknown>();
  for (const row of payload.ac ?? []) {
    const observation = normalizeAdsbLolAircraft(row, receivedAtMs, providerNowMs);
    if (observation) {
      observations.push(observation);
      if (observation.providerRecordId) rawByRecordId.set(observation.providerRecordId, row);
    }
  }

  return {
    observations,
    receivedAt: new Date(receivedAtMs).toISOString(),
    sources: ["adsb_lol"],
    rawByRecordId,
  };
}

export async function fetchLiveAircraft(
  config: AdsbProviderConfig,
  query: { lat: number; lon: number; radiusNm: number },
  fetchImpl: typeof fetch = fetch,
): Promise<LiveAircraftResult> {
  if (config.provider === "adsb_lol") return fetchAdsbLolNearby(config, query, fetchImpl);
  // Other provider identities require a dedicated adapter after docs/provider-onboarding.md is completed.
  throw Object.assign(new Error("provider_adapter_not_implemented"), { code: "provider_adapter_not_implemented" as const });
}

export { DEFAULT_ADSB_LOL_BASE };
