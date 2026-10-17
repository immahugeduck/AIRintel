import { z } from "zod";
import { distanceNm } from "../src/domain/geometry.js";
import { milesToNm } from "../src/domain/units.js";
import type { NetConfig } from "./config.js";
import type { Queryable } from "./db.js";
import { log, errorFields } from "./logger.js";
import { acquireSweepLease, getSweepState, loadDueAreas, markAreasPolled, purgeOldObservations, releaseSweepLease, type SweepArea } from "./net-watch.js";
import { recordEncounters } from "./encounters.js";
import { toRecorderObservations } from "./live-recording.js";
import { fetchLiveAircraft, type AdsbProviderConfig, type LiveAircraftResult, type ProviderFetchOptions } from "./providers/adsb.js";
import { recordObservations, type RecordResult } from "./recorder.js";

/**
 * Always-on net sweep: loads every enabled watch area, merges overlapping provider queries, fetches REAL aircraft
 * from the provider adapter, and writes them through the existing recorder (provider identity, schema versions,
 * observed + received timestamps and dedupe-by-provider-record-id are all preserved by `toRecorderObservations` /
 * `recordObservations`), then advances each area owner's encounter log (server/encounters.ts, `netted-visits-v1` rule).
 */

export const MAX_FETCH_RADIUS_NM = 50;
export const SWEEP_LEASE_SECONDS = 45;
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
  errors: { code: string; count: number }[];
  retention?: { deleted: number };
};

export type PlannedQuery = { latitude: number; longitude: number; radiusNm: number; members: SweepArea[] };
export type SweepPlan = { queries: PlannedQuery[]; covered: number; deferred: SweepArea[] };

/** Provider query radius for one area: radius x margin (so exits/entries are observed), capped. */
export const fetchRadiusNm = (radiusMi: number, marginFactor: number) => Math.min(MAX_FETCH_RADIUS_NM, Math.max(1, milesToNm(radiusMi) * marginFactor));

/**
 * Groups areas into provider queries. Areas are taken in the given order (least recently polled first); an area whose
 * fetch circle lies entirely inside an already planned query rides on that query (the data is global, so nothing is
 * fetched twice). When more than `maxQueries` distinct queries would be needed, the rest are deferred to the next sweep.
 */
export function planSweep(areas: readonly SweepArea[], marginFactor: number, maxQueries: number): SweepPlan {
  const queries: PlannedQuery[] = [];
  const deferred: SweepArea[] = [];
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

function providerErrorCode(error: unknown): string {
  if (error instanceof z.ZodError) return "provider_invalid_payload";
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "provider_timeout";
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  if (code === "provider_adapter_not_implemented") return code;
  if (/^adsb_lol_upstream_\d{3}$/.test(code)) return "provider_upstream_failed";
  return "provider_network_error";
}

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
    errors: [],
  };
  const finish = (status: SweepStatus): SweepSummary => {
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
    const due = await loadDueAreas(deps.db, { minIntervalSeconds: deps.net.minIntervalSeconds, limit: Math.max(deps.net.maxAreas * 4, 100) });
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
      const providerOptions: ProviderFetchOptions = { timeoutMs: Math.max(2_000, Math.min(8_000, remaining)), retries: remaining > 12_000 ? 1 : 0, ...deps.providerOptions };
      const memberIds = query.members.map((member) => member.userId);
      let result: LiveAircraftResult;
      try {
        result = await fetchLiveAircraft(deps.adsb, { lat: query.latitude, lon: query.longitude, radiusNm: query.radiusNm }, deps.fetchImpl ?? fetch, providerOptions);
      } catch (error) {
        const code = providerErrorCode(error);
        addError(code);
        failedQueries += 1;
        log("warn", "net_sweep_provider_failed", { code, ...errorFields(error) });
        await markAreasPolled(deps.db, memberIds, code === "provider_timeout" || code === "provider_upstream_failed" || code === "provider_network_error" ? "provider_error" : code, false).catch((e) => log("error", "net_sweep_mark_failed", errorFields(e)));
        continue;
      }
      summary.observations.fetched += result.observations.length;

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
          const written = await recordEncounters(deps.db, member.userId, { latitude: member.latitude, longitude: member.longitude, radiusNm: milesToNm(member.radiusMi) }, recorded, "sweep");
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
      await markAreasPolled(deps.db, memberIds, status, success).catch((e) => log("error", "net_sweep_mark_failed", errorFields(e)));
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
