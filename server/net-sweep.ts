import { distanceNm } from "../src/domain/geometry.js";
import { milesToNm } from "../src/domain/units.js";
import type { NetConfig } from "./config.js";
import type { Queryable } from "./db.js";
import { log, errorFields } from "./logger.js";
import { acquireSweepLease, getSweepState, loadDueAreas, markAreasPolled, purgeOldObservations, releaseSweepLease, type SweepArea } from "./net-watch.js";
import { loadDueControlAreas, markControlAreasPolled, recordControlSightings, type ControlSweepArea } from "./control-areas.js";
import { recordEncounters } from "./encounters.js";
import { toRecorderObservations } from "./live-recording.js";
import { classifyProviderError, fetchLiveAircraft, ProviderChainError, type AdsbProviderConfig, type LiveAircraftResult, type ProviderFailure, type ProviderFetchOptions } from "./providers/adsb.js";
import { recordObservations, type RecordResult } from "./recorder.js";

/**
 * Always-on net sweep: loads every enabled watch area, merges overlapping provider queries, fetches REAL aircraft
 * from the provider adapter, and writes them through the existing recorder (provider identity, schema versions,
 * observed + received timestamps and dedupe-by-provider-record-id are all preserved by `toRecorderObservations` /
 * `recordObservations`), then advances each area owner's encounter log (server/encounters.ts, `netted-visits-v1` rule).
 */

export const MAX_FETCH_RADIUS_NM = 50;
/**
 * Per-attempt wait for adsb.lol. It can take 10+ s to answer when busy, so 15 s (was 8 s) gives a slow but working
 * provider a chance. Must fit (with the default 40 s budget) inside the Vercel function limit (vercel.json maxDuration 60).
 */
export const PROVIDER_TIMEOUT_MS = 15_000;
/**
 * With fallbacks configured adsb.lol gets one 12 s attempt (no retry: a failing adsb.lol usually fails the same way
 * twice, and undici gives up on an unanswered TCP connect after ~10 s), then each fallback 8 s. 12 + 8 + 8 s plus the
 * 1 req/s spacing fits the default 40 s budget inside maxDuration 60.
 */
export const PRIMARY_WITH_FALLBACK_TIMEOUT_MS = 12_000;
export const FALLBACK_TIMEOUT_MS = 8_000;
/** The lease outlives the longest possible run (maxDuration 60 s), so an overlapping sweep can never start mid-run. */
export const SWEEP_LEASE_SECONDS = 75;
const RECORD_CHUNK = 20;
const PURGE_BATCH = 5_000;
const PURGE_EVERY_MS = 6 * 3_600_000;

export type SweepStatus = "completed" | "partial" | "failed" | "no_areas" | "skipped_locked" | "provider_not_configured";

/** Compact, secret-free summary returned by the endpoint. Never contains coordinates, user ids or provider payloads. */
export type SweepSummary = {
  ok: boolean;
  status: SweepStatus;
  startedAt: string;
  durationMs: number;
  areas: { due: number; queried: number; covered: number; deferred: number };
  observations: { fetched: number; inserted: number; duplicate: number; rejected: number };
  /** New per-account encounters detected by this sweep (counts only). */
  encounters: { started: number };
  /** Control circles (migration 0007) swept, and the (aircraft, day) sighting rows they updated. */
  controls: { swept: number; sightings: number };
  errors: { code: string; count: number }[];
  /** Which provider served each query and which failed (machine codes only). Present once a query was attempted. */
  providers?: { served: { provider: string; queries: number }[]; failures: (ProviderFailure & { count: number })[] };
  retention?: { deleted: number };
};

/** A watch area (encounters for its owner) or a control circle (day counts only). */
export type SweepMember = SweepArea | ControlSweepArea;
export type PlannedQuery = { latitude: number; longitude: number; radiusNm: number; members: SweepMember[] };
export type SweepPlan = { queries: PlannedQuery[]; covered: number; deferred: SweepMember[] };

const isControl = (member: SweepMember): member is ControlSweepArea => (member as ControlSweepArea).kind === "control";

/** Marks every member polled in its own table (watch areas by owner, control circles by id). */
async function markPolled(db: Queryable, members: readonly SweepMember[], status: string, success: boolean): Promise<void> {
  await Promise.all([
    markAreasPolled(db, members.filter((m) => !isControl(m)).map((m) => m.userId), status, success),
    markControlAreasPolled(db, members.filter(isControl).map((m) => m.controlId), status, success),
  ]);
}

/** Provider query radius for one area: radius x margin (so exits/entries are observed), capped. */
export const fetchRadiusNm = (radiusMi: number, marginFactor: number) => Math.min(MAX_FETCH_RADIUS_NM, Math.max(1, milesToNm(radiusMi) * marginFactor));

/**
 * Groups areas into provider queries. Areas are taken in the given order (least recently polled first); an area whose
 * fetch circle lies entirely inside an already planned query rides on that query (the data is global, so nothing is
 * fetched twice). When more than `maxQueries` distinct queries would be needed, the rest are deferred to the next sweep.
 */
export function planSweep(areas: readonly SweepMember[], marginFactor: number, maxQueries: number): SweepPlan {
  const queries: PlannedQuery[] = [];
  const deferred: SweepMember[] = [];
  let covered = 0;
  for (const area of areas) {
    const radiusNm = fetchRadiusNm(area.radiusMi, marginFactor);
    const host = queries.find((query) => distanceNm(query.latitude, query.longitude, area.latitude, area.longitude) + radiusNm <= query.radiusNm + 1e-9);
    if (host) { host.members.push(area); covered += 1; continue; }
    if (queries.length >= maxQueries) { deferred.push(area); continue; }
    queries.push({ latitude: area.latitude, longitude: area.longitude, radiusNm, members: [area] });
  }
  return { queries, covered, deferred };
}

/**
 * Wait per provider attempt for the time left in the sweep budget: up to PROVIDER_TIMEOUT_MS, and one retry only when
 * two full attempts (plus backoff) still fit.
 */
export function providerAttemptOptions(remainingMs: number): { timeoutMs: number; retries: number } {
  return { timeoutMs: Math.max(2_000, Math.min(PROVIDER_TIMEOUT_MS, remainingMs)), retries: remainingMs >= PROVIDER_TIMEOUT_MS * 2 + 2_000 ? 1 : 0 };
}

/** Options for one query's provider chain, given the sweep budget left. */
export function providerChainOptions(remainingMs: number, hasFallbacks: boolean): ProviderFetchOptions & { timeoutMs: number; retries: number; budgetMs: number } {
  if (!hasFallbacks) return { ...providerAttemptOptions(remainingMs), budgetMs: remainingMs };
  return { timeoutMs: Math.max(2_000, Math.min(PRIMARY_WITH_FALLBACK_TIMEOUT_MS, remainingMs)), retries: 0, fallbackTimeoutMs: FALLBACK_TIMEOUT_MS, budgetMs: remainingMs };
}

export type SweepDeps = {
  db: Queryable;
  adsb: AdsbProviderConfig | null;
  net: NetConfig;
  fetchImpl?: typeof fetch;
  providerOptions?: ProviderFetchOptions;
  now?: () => number;
  /** Test hook; defaults to the real recorder. */
  record?: typeof recordObservations;
};

export class SweepNotReadyError extends Error {
  constructor() { super("net_tables_missing"); this.name = "SweepNotReadyError"; }
}

const providerErrorCode = (error: unknown): string => classifyProviderError(error);

const isMissingTable = (error: unknown) => error && typeof error === "object" && (error as { code?: unknown }).code === "42P01";

export async function runSweep(deps: SweepDeps): Promise<SweepSummary> {
  const now = deps.now ?? Date.now;
  const started = now();
  const record = deps.record ?? recordObservations;
  const errors = new Map<string, number>();
  const addError = (code: string) => errors.set(code, (errors.get(code) ?? 0) + 1);
  const summary: SweepSummary = {
    ok: true, status: "completed", startedAt: new Date(started).toISOString(), durationMs: 0,
    areas: { due: 0, queried: 0, covered: 0, deferred: 0 },
    observations: { fetched: 0, inserted: 0, duplicate: 0, rejected: 0 },
    encounters: { started: 0 },
    controls: { swept: 0, sightings: 0 },
    errors: [],
  };
  const served = new Map<string, number>();
  const providerFailures = new Map<string, ProviderFailure & { count: number }>();
  /** Providers that failed earlier in this sweep: later queries go straight to the next provider. */
  const failedProviders = new Set<string>();
  const noteFailures = (failures: readonly ProviderFailure[]) => {
    for (const failure of failures) {
      const key = `${failure.provider}|${failure.code}|${failure.detail ?? ""}`;
      const entry = providerFailures.get(key);
      if (entry) entry.count += 1; else providerFailures.set(key, { ...failure, count: 1 });
      if (failure.code !== "provider_skipped" && failure.code !== "provider_budget_exhausted") failedProviders.add(failure.provider);
    }
  };
  const finish = (status: SweepStatus): SweepSummary => {
    if (served.size > 0 || providerFailures.size > 0) summary.providers = { served: [...served].map(([provider, queries]) => ({ provider, queries })), failures: [...providerFailures.values()] };
    summary.status = status;
    summary.ok = status !== "failed";
    summary.durationMs = now() - started;
    summary.errors = [...errors].map(([code, count]) => ({ code, count }));
    return summary;
  };

  if (!deps.adsb) return finish("provider_not_configured");

  let leased: boolean;
  try {
    leased = await acquireSweepLease(deps.db, SWEEP_LEASE_SECONDS);
  } catch (error) {
    if (isMissingTable(error)) throw new SweepNotReadyError();
    throw error;
  }
  if (!leased) return finish("skipped_locked");

  try {
    const limit = Math.max(deps.net.maxAreas * 4, 100);
    // Watch areas first: control circles only fill provider queries that are left (or ride on overlapping ones).
    const due: SweepMember[] = [
      ...await loadDueAreas(deps.db, { minIntervalSeconds: deps.net.minIntervalSeconds, limit }),
      ...await loadDueControlAreas(deps.db, { minIntervalSeconds: deps.net.minIntervalSeconds, limit }),
    ];
    summary.areas.due = due.length;
    const plan = planSweep(due, deps.net.marginFactor, deps.net.maxAreas);
    summary.areas.covered = plan.covered;
    summary.areas.deferred = plan.deferred.length;

    let attempted = 0;
    let failedQueries = 0;
    for (const query of plan.queries) {
      const elapsed = now() - started;
      if (elapsed >= deps.net.budgetMs) {
        summary.areas.deferred += query.members.length;
        addError("sweep_budget_exhausted");
        continue; // not marked polled: the next sweep picks these up first
      }
      attempted += 1;
      summary.areas.queried += 1;
      const remaining = deps.net.budgetMs - elapsed;
      const providerOptions: ProviderFetchOptions = { ...providerChainOptions(remaining, (deps.adsb.fallbacks?.length ?? 0) > 0), skipProviders: failedProviders, ...deps.providerOptions };
      let result: LiveAircraftResult;
      try {
        result = await fetchLiveAircraft(deps.adsb, { lat: query.latitude, lon: query.longitude, radiusNm: query.radiusNm }, deps.fetchImpl ?? fetch, providerOptions);
      } catch (error) {
        const code = providerErrorCode(error);
        if (error instanceof ProviderChainError) noteFailures(error.failures);
        else noteFailures([{ provider: deps.adsb.provider, code }]);
        addError(code);
        failedQueries += 1;
        log("warn", "net_sweep_provider_failed", { code, ...errorFields(error) });
        await markPolled(deps.db, query.members, code === "provider_timeout" || code === "provider_upstream_failed" || code === "provider_network_error" ? "provider_error" : code, false).catch((e) => log("error", "net_sweep_mark_failed", errorFields(e)));
        continue;
      }
      summary.observations.fetched += result.observations.length;
      const servedBy = result.sources[0] ?? deps.adsb.provider;
      served.set(servedBy, (served.get(servedBy) ?? 0) + 1);
      if (result.providerFailures?.length) {
        noteFailures(result.providerFailures);
        log("warn", "net_sweep_provider_fallback", { served: servedBy, failed: result.providerFailures.map((f) => `${f.provider}=${f.code}${f.detail ? `(${f.detail})` : ""}`).join("; ") });
      }

      const recorderInput = toRecorderObservations(result);
      const totals: RecordResult = { received: 0, inserted: 0, duplicate: 0, rejected: 0 };
      let cut = false;
      let processed = 0;
      for (let offset = 0; offset < recorderInput.length; offset += RECORD_CHUNK) {
        if (now() - started > deps.net.budgetMs + 6_000) { cut = true; break; }
        const part = await record(deps.db, recorderInput.slice(offset, offset + RECORD_CHUNK));
        processed = Math.min(recorderInput.length, offset + RECORD_CHUNK);
        totals.received += part.received; totals.inserted += part.inserted; totals.duplicate += part.duplicate; totals.rejected += part.rejected;
      }
      // Credit every member area's owner with their own encounters (each measured against that user's radius).
      if (totals.inserted + totals.duplicate > 0) {
        const recorded = recorderInput.slice(0, processed);
        for (const member of query.members) {
          if (isControl(member)) {
            try {
              summary.controls.sightings += await recordControlSightings(deps.db, member, recorded);
              summary.controls.swept += 1;
            } catch (error) {
              addError("control_record_failed");
              log("error", "net_sweep_control_failed", errorFields(error));
            }
            continue;
          }
          const written = await recordEncounters(deps.db, member.userId, { latitude: member.latitude, longitude: member.longitude, radiusNm: milesToNm(member.radiusMi), centerMode: member.followMe ? "follow" : "fixed" }, recorded, "sweep");
          summary.encounters.started += written.started;
        }
      }
      summary.observations.inserted += totals.inserted;
      summary.observations.duplicate += totals.duplicate;
      summary.observations.rejected += totals.rejected;

      let status = "ok";
      let success = true;
      if (totals.rejected > 0 && totals.inserted + totals.duplicate === 0) { status = "record_error"; success = false; addError("record_failed"); failedQueries += 1; }
      else if (totals.rejected > 0 || cut) { status = "partial"; if (cut) addError("sweep_budget_exhausted"); }
      await markPolled(deps.db, query.members, status, success).catch((e) => log("error", "net_sweep_mark_failed", errorFields(e)));
    }

    if (deps.net.retentionDays && now() - started < deps.net.budgetMs) {
      try {
        const state = await getSweepState(deps.db);
        const lastPurge = state?.last_purge_at ? state.last_purge_at.getTime() : 0;
        if (!lastPurge || now() - lastPurge >= PURGE_EVERY_MS || (state?.last_purge_deleted ?? 0) >= PURGE_BATCH) {
          summary.retention = { deleted: await purgeOldObservations(deps.db, deps.net.retentionDays, PURGE_BATCH) };
        }
      } catch (error) {
        addError("retention_failed");
        log("error", "net_sweep_retention_failed", errorFields(error));
      }
    }

    const allFailed = attempted > 0 && failedQueries === attempted;
    const status: SweepStatus = summary.areas.due === 0 ? "no_areas" : allFailed ? "failed" : errors.size > 0 || summary.areas.deferred > 0 ? "partial" : "completed";
    await releaseSweepLease(deps.db, { status, areasPolled: summary.areas.queried + summary.areas.covered, observationsInserted: summary.observations.inserted });
    return finish(status);
  } catch (error) {
    await releaseSweepLease(deps.db, { status: "failed", areasPolled: 0, observationsInserted: 0 }).catch(() => undefined);
    throw error;
  }
}
