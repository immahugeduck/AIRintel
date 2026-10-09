import { bearerToken, hasScope, type RateLimiter, type TokenVerifier } from "./auth.js";
import type { Queryable } from "./db.js";
import { ADSB_LOL_NORMALIZATION_VERSION, ADSB_LOL_PROVIDER_SCHEMA_VERSION, type LiveAircraftResult } from "./providers/adsb.js";
import { recordObservations, type RecordResult, type RecorderObservation } from "./recorder.js";

/**
 * Live-view contribution to the flight recorder.
 *
 * The public /aircraft-nearby gateway stays anonymous-readable, but when the caller presents a verified Neon Auth JWT
 * whose user holds the `history` grant, the REAL observations the provider just returned are written through the
 * existing recorder (`recordObservations` -> `public.record_aircraft_observation`). That is how aircraft seen while
 * the app is open appear in the Netted Aircraft log. Anonymous callers never cause database writes.
 */
export type LiveRecordingDeps = { db: Queryable | null; verifier: TokenVerifier | null; limiter: RateLimiter; timeoutMs?: number };
export type LiveRecordingStatus = "recorded" | "not_signed_in" | "no_history_access" | "unavailable" | "rate_limited" | "radius_too_large" | "timeout" | "failed";

/** Writes are capped to bounded watch areas so one caller cannot ingest a huge region. */
export const MAX_RECORDING_RADIUS_NM = 50;

export function toRecorderObservations(result: LiveAircraftResult): RecorderObservation[] {
  return result.observations.flatMap((observation) => {
    const raw = observation.providerRecordId ? result.rawByRecordId?.get(observation.providerRecordId) : undefined;
    if (raw === undefined || observation.provider !== "adsb_lol") return [];
    return [{
      provider: observation.provider,
      providerSchemaVersion: ADSB_LOL_PROVIDER_SCHEMA_VERSION,
      normalizationVersion: ADSB_LOL_NORMALIZATION_VERSION,
      ...(observation.providerRecordId ? { providerRecordId: observation.providerRecordId } : {}),
      icao24: observation.icao24,
      registration: observation.registration,
      callsign: observation.callsign,
      latitude: observation.latitude,
      longitude: observation.longitude,
      altitudeFt: observation.altitudeFt,
      altitudeSource: observation.altitudeSource,
      geometricAltitudeFt: observation.geometricAltitudeFt,
      barometricAltitudeFt: observation.barometricAltitudeFt,
      groundSpeedKt: observation.groundSpeedKt,
      trackDeg: observation.trackDeg,
      verticalRateFpm: observation.verticalRateFpm,
      onGround: observation.onGround,
      observedAt: observation.observedAt,
      receivedAt: observation.receivedAt,
      raw: raw as RecorderObservation["raw"],
    }];
  });
}

export async function recordLiveObservations(deps: LiveRecordingDeps | null, authorization: string | undefined, radiusNm: number, result: LiveAircraftResult): Promise<{ status: LiveRecordingStatus; result?: RecordResult }> {
  const token = bearerToken(authorization);
  if (!token) return { status: "not_signed_in" };
  if (!deps?.db || !deps.verifier) return { status: "unavailable" };
  if (radiusNm > MAX_RECORDING_RADIUS_NM) return { status: "radius_too_large" };
  const user = await deps.verifier(token);
  if (!user) return { status: "not_signed_in" };
  try {
    if (!(await hasScope(deps.db, user.id, "history"))) return { status: "no_history_access" };
  } catch {
    return { status: "failed" };
  }
  if (deps.limiter.hit(user.id) !== null) return { status: "rate_limited" };
  const db = deps.db;
  const write = recordObservations(db, toRecorderObservations(result)).then(
    (written) => ({ status: "recorded" as const, result: written }),
    () => ({ status: "failed" as const }),
  );
  const timeout = new Promise<{ status: LiveRecordingStatus }>((resolve) => setTimeout(() => resolve({ status: "timeout" }), deps.timeoutMs ?? 6_000));
  try {
    return await Promise.race([write, timeout]);
  } catch {
    return { status: "failed" };
  }
}
