import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ProfileNotFoundError, fetchAircraftProfile } from "../api/profile";
import type { NetStatus } from "../domain/net";
import { registryAvailabilityNotice } from "../domain/profile";
import { downloadText, nettedEntriesToCsv, nettedFilename, nettedToCsv, nettedToJson } from "../lib/netted-export";
import type { NettedAircraft, NettedVisit } from "../domain/netted";
import { PATTERN_TIER_LABEL, PATTERN_TIER_ORDER, type PatternAssessment } from "../domain/patterns";
import { formatAltitudeFt, formatLastSeen, formatSpeedMph } from "../domain/units";
import { compassPoint } from "../domain/geometry";
import { COMPARE_MIN_ENTRIES, passFlags, straightPassMinutes, timeInside, typicalPass, type PassFlag, type TypicalPass } from "../domain/encounter-compare";
import { AccessDeniedError, AuthenticationRequiredError, ProviderNotConfiguredError } from "../providers/contracts";
import { formatRadius } from "./AircraftList";
import { NetStatusLine } from "./NetControl";

export type NettedState =
  | { kind: "loading" }
  | { kind: "ready"; aircraft: NettedAircraft[]; hours: number; truncated: boolean; source: "recorded"; net?: NetStatus | null | undefined; /** Counts are lifetime totals from the account's saved encounter log. */ lifetime?: boolean | undefined; /** Whether pattern flags are complete. */ patternStatus?: { state: "ok" | "partial" | "failed"; detail: string | null } | null | undefined }
  | { kind: "session"; aircraft: NettedAircraft[]; reason: "signed-out" | "no-access" | "unconfigured" | "error"; message?: string };

type Props = {
  state: NettedState;
  radiusMi: number;
  selectedIcao24: string | null;
  onSelect: (icao24: string) => void;
  onSignIn?: () => void;
  timeZone?: string;
  /** Disable the lazy profile lookup (test harness). */
  profileLookup?: boolean;
  /** "drawer" opens every entry log by default and drops the outer panel chrome. */
  variant?: "tab" | "drawer";
  /** Entries that began after this UTC timestamp are tagged "New" (drawer: time of the previous open). */
  newSince?: string | null;
  /** Opens the settings where the always-on net is switched on. */
  onOpenNetSettings?: () => void;
};

const VISIBLE_VISITS = 5;

type PatternFilter = "all" | "flagged" | "hide-routine";
const isFlagged = (item: NettedAircraft) => item.pattern?.tier === "priority" || item.pattern?.tier === "review";

/** Review-priority badge. Wording describes recorded behavior only; it never asserts intent or surveillance. */
export function PatternBadge({ pattern }: { pattern: PatternAssessment | null | undefined }) {
  if (!pattern || pattern.tier === "low") return null;
  if (pattern.tier === "insufficient") return <span className="pattern-badge is-insufficient" title="Too few recorded positions to judge behavior">Not enough data</span>;
  const label = pattern.tier === "routine" ? `Routine${pattern.explainedBy ? ` · ${shortExplanation(pattern.explainedBy)}` : ""}` : PATTERN_TIER_LABEL[pattern.tier];
  const mismatch = pattern.fit === "not_explained" && pattern.context ? ` · ${shortExplanation(pattern.context)}, not explained` : "";
  return <span className={`pattern-badge is-${pattern.tier}`} title={pattern.tier === "routine" ? pattern.explainedBy ?? undefined : `Score ${pattern.score}`}>{label}{mismatch}</span>;
}

const shortExplanation = (text: string) => (/training/i.test(text) ? "flight school" : /cargo/i.test(text) ? "cargo" : /fractional|charter/i.test(text) ? "charter jet" : /flight number/i.test(text) ? "airline" : /cruise/i.test(text) ? "transit" : /climb|descend/i.test(text) ? "arrival/departure" : /traffic pattern|airport/i.test(text) ? "airport traffic" : "explained");

/** "Why flagged": every reason with its evidence label (Observed / Calculated / Supported inference / Unknown). */
export function PatternReasons({ pattern }: { pattern: PatternAssessment }) {
  const [open, setOpen] = useState(false);
  if (pattern.reasons.length === 0) return null;
  return (
    <div className="pattern-reasons">
      <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide pattern details" : pattern.tier === "routine" ? "Why routine" : "Why flagged"} · score {pattern.score}</button>
      {open && (
        <>
          {pattern.context && (
            <p className={`pattern-context ${pattern.fit === "not_explained" ? "is-mismatch" : ""}`}>
              <strong>Context:</strong> {pattern.context}.{" "}
              {pattern.fit === "not_explained" ? "Some recorded behavior is not explained by this (see below)." : pattern.fit === "consistent" ? "Recorded behavior is consistent with it." : ""}
            </p>
          )}
          <ul className="pattern-reason-list">
            {pattern.reasons.map((reason) => (
              <li key={reason.code} className={reason.weight > 0 ? "is-raise" : reason.weight < 0 ? "is-lower" : ""}>
                <span className="mono pattern-weight">{reason.weight > 0 ? `+${reason.weight}` : reason.weight}</span>
                <span>{reason.label} <small className="evidence-tag">{reason.evidence}</small></span>
              </li>
            ))}
          </ul>
          <p className="fine-print">Ranks recorded behavior for review ({pattern.version}). It does not establish who is aboard, why the aircraft flew there, or that anyone is being watched.</p>
        </>
      )}
    </div>
  );
}

/** Per-visit timeline: every time the aircraft entered the radius, newest first (Observed). */
export function VisitTimeline({ item, timeZone, newSince, defaultOpen, radiusMi }: { item: NettedAircraft; timeZone?: string | undefined; newSince?: string | null | undefined; defaultOpen: boolean; radiusMi?: number | undefined }) {
  const [open, setOpen] = useState(defaultOpen);
  const [all, setAll] = useState(false);
  const visits: NettedVisit[] = item.visits;
  if (visits.length === 0) return null;
  const shown = all ? visits : visits.slice(0, VISIBLE_VISITS);
  const listId = `visits-${item.icao24}`;
  const typical = typicalPass(visits);
  return (
    <div className="visit-log">
      <button type="button" className="disclosure" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        {open ? "Hide entry log" : "Entry log"} · {item.visitCount}
      </button>
      {open && (
        <>
          <TypicalPassLine typical={typical} />
          <ol id={listId} className="visit-timeline" aria-label={`Entries into the radius for ${item.callsign ?? item.icao24.toUpperCase()}`}>
            {shown.map((visit, index) => {
              const isNew = Boolean(newSince) && Date.parse(visit.enteredAt) > Date.parse(newSince!);
              return (
                <li key={visit.enteredAt} className="visit-entry">
                  <span className="visit-dot" aria-hidden="true" />
                  <div className="visit-body">
                    <span className="visit-time mono">{formatLastSeen(visit.enteredAt, timeZone)}{isNew && <span className="new-tag">New</span>}</span>
                    <span className="visit-detail">
                      Entry {item.visitCount - index} · {describeStay(visit)} · closest {visit.closestMi.toFixed(1)} mi
                    </span>
                    <ClosestPointLine visit={visit} timeZone={timeZone} flags={passFlags(visit, typical, radiusMi)} radiusMi={radiusMi} />
                  </div>
                </li>
              );
            })}
          </ol>
          {visits.length > VISIBLE_VISITS && (
            <button type="button" className="disclosure" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${visits.length} entries`}</button>
          )}
          {item.visitCount > visits.length && <p className="fine-print">Showing the newest {visits.length} of {item.visitCount} entries.</p>}
        </>
      )}
    </div>
  );
}

const FLAG_LABEL: Record<PassFlag, string> = { closer: "Closer than usual", lower: "Lower than usual", longer: "Longer than usual", lingered: "Lingered (3× a straight pass)" };

const clockTime = (iso: string, timeZone?: string) =>
  new Intl.DateTimeFormat("en-US", { ...(timeZone ? { timeZone } : {}), hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(iso)).toLowerCase().replace(" ", "");

/** Flight state at the closest recorded point of one entry (Observed) plus comparison flags (Calculated). */
export function ClosestPointLine({ visit, timeZone, flags = [], radiusMi }: { visit: NettedVisit; timeZone?: string | undefined; flags?: PassFlag[]; radiusMi?: number | undefined }) {
  const point = visit.closest;
  if (!point) return <span className="visit-closest fine-print">Closest-point details not recorded for this entry.</span>;
  const parts = [
    formatAltitudeFt(point.altitudeFt, point.onGround),
    formatSpeedMph(point.groundSpeedKt),
    point.trackDeg !== null ? `heading ${compassPoint(point.trackDeg)}` : null,
    point.bearingFromCenterDeg !== null ? `${visit.closestMi.toFixed(1)} mi ${compassPoint(point.bearingFromCenterDeg)} of center` : null,
    `at ${clockTime(point.at, timeZone)}`,
  ].filter(Boolean);
  const straight = straightPassMinutes(visit, visit.radiusMi ?? radiusMi);
  if (straight !== null) parts.push(`a straight pass at this speed takes ${straight < 1 ? "under 1" : `about ${Math.round(straight)}`} min`);
  return (
    <span className="visit-closest">
      <span className="visit-closest-label">At closest:</span> {parts.join(" · ")}
      {flags.map((flag) => <span key={flag} className="pass-flag">{FLAG_LABEL[flag]}</span>)}
    </span>
  );
}

/** Median pass for this aircraft over your location, shown once it has enough entries to compare. */
function TypicalPassLine({ typical }: { typical: TypicalPass }) {
  if (typical.entries < 2) return null;
  const minutes = typical.minutesInside;
  const parts = [
    typical.closestMi !== null ? `closest ${typical.closestMi.toFixed(1)} mi` : null,
    typical.altitudeFt !== null ? `${Math.round(typical.altitudeFt).toLocaleString("en-US")} ft` : null,
    typical.speedMph !== null ? `${Math.round(typical.speedMph)} mph` : null,
    minutes !== null ? (minutes < 1 ? "inside under 1 min" : `inside ${Math.round(minutes)} min`) : null,
  ].filter(Boolean);
  return (
    <p className="typical-pass fine-print">
      <strong>Typical pass</strong> (median of {typical.entries} entries with details): {parts.join(" · ")}
      {typical.entries < COMPARE_MIN_ENTRIES && ` · comparison flags start at ${COMPARE_MIN_ENTRIES} entries`}
    </p>
  );
}

/**
 * Time inside, only as precisely as the recorded sightings support (no interpolation): a range when the sightings just
 * outside the radius on both sides are known ("inside 4–6 min"), otherwise a lower bound ("inside at least 4 min").
 */
export function describeStay(visit: NettedVisit): string {
  const { atLeast, atMost } = timeInside(visit);
  const fmt = (minutes: number) => (minutes < 1 ? "under 1" : String(Math.round(minutes)));
  if (atMost !== null) {
    const low = fmt(atLeast);
    const high = fmt(atMost);
    if (low === high) return high === "under 1" ? "inside under 1 min" : `inside about ${high} min`;
    return atLeast < 1 ? `inside up to ${high} min` : `inside ${low}–${high} min`;
  }
  if (visit.observationCount <= 1) return "seen once inside";
  if (atLeast < 1) return `${visit.observationCount} sightings inside`;
  return `inside at least ${fmt(atLeast)} min`;
}

const reasonCopy: Record<Extract<NettedState, { kind: "session" }>["reason"], string> = {
  "signed-out": "Sign in to keep a saved Netted log. Until then, only aircraft seen during this visit are counted, and they are not saved.",
  "no-access": "Access for this account has been turned off, so the saved Netted log is unavailable. Showing this visit only.",
  unconfigured: "Recorded history is not configured for this deployment (database or sign-in missing). Showing this visit only; nothing is saved.",
  error: "The saved Netted log could not be loaded. Showing this visit only.",
};

/** Aircraft netted inside the watch radius with a visit counter and a short sourced description. */
export function NettedPanel({ state, radiusMi, selectedIcao24, onSelect, onSignIn, timeZone, profileLookup = true, variant = "tab", newSince = null, onOpenNetSettings }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<PatternFilter>("all");
  const allAircraft = state.kind === "loading" ? [] : state.aircraft;
  const hasPatterns = allAircraft.some((item) => item.pattern);
  const flaggedCount = allAircraft.filter(isFlagged).length;
  const aircraft = filter === "all" ? allAircraft
    : [...allAircraft.filter((item) => (filter === "flagged" ? isFlagged(item) : item.pattern?.tier !== "routine"))]
      .sort((a, b) => (PATTERN_TIER_ORDER[a.pattern?.tier ?? "low"] - PATTERN_TIER_ORDER[b.pattern?.tier ?? "low"]) || ((b.pattern?.score ?? 0) - (a.pattern?.score ?? 0)));
  const totalVisits = aircraft.reduce((sum, item) => sum + item.visitCount, 0);

  const net = state.kind === "ready" ? state.net ?? null : null;
  const lifetime = state.kind === "ready" && state.lifetime === true;
  const drawer = variant === "drawer";
  return (
    <section className={`panel netted${drawer ? " netted-drawer-panel" : ""}`} aria-labelledby={`netted-heading${drawer ? "-drawer" : ""}`}>
      <header className="panel-header">
        <div>
          <p className="eyebrow">Entered my {formatRadius(radiusMi)} radius{state.kind === "ready" ? (state.lifetime ? " · all time, saved to your account" : ` · last ${state.hours >= 48 ? `${Math.round(state.hours / 24)} days` : `${state.hours} h`}`) : state.kind === "session" ? " · this visit" : ""}</p>
          <h2 id={`netted-heading${drawer ? "-drawer" : ""}`}>Netted aircraft <span className="count-badge" aria-label={`${aircraft.length} aircraft`}>{aircraft.length}</span></h2>
        </div>
        {aircraft.length > 0 && (
          <div className="netted-export">
            <span className="hint">{totalVisits} {totalVisits === 1 ? "entry" : "entries"}</span>
            <button type="button" className="button button-ghost" aria-label="Export netted list as CSV" onClick={() => downloadText(nettedFilename("csv"), nettedToCsv(aircraft), "text/csv;charset=utf-8")}>CSV</button>
            <button type="button" className="button button-ghost" aria-label="Export every entry with closest-point details as CSV" onClick={() => downloadText(nettedFilename("csv", new Date(), "entries"), nettedEntriesToCsv(aircraft, radiusMi), "text/csv;charset=utf-8")}>Entries CSV</button>
            <button type="button" className="button button-ghost" aria-label="Export netted list as JSON" onClick={() => downloadText(nettedFilename("json"), nettedToJson(aircraft, { radiusMi, scope: lifetime ? "all-time log" : state.kind === "ready" ? `last ${state.hours} h` : "this visit" }), "application/json")}>JSON</button>
          </div>
        )}
      </header>

      {net && (
        <div className="net-banner">
          <NetStatusLine status={net} />
          {net.state === "stale" && <p className="notice notice-warn" role="alert"><span>No successful sweep in the last {net.staleAfterMinutes} minutes while the net is enabled. Passes during that time may be missing. Check the scheduler (GitHub Action or cron) and <code>/api/health</code>.</span></p>}
          {net.state === "paused" && onOpenNetSettings && <button type="button" className="button button-ghost" onClick={onOpenNetSettings}>Turn on “Keep netting when app is closed”</button>}
          {net.state !== "paused" && onOpenNetSettings && <button type="button" className="link-button" onClick={onOpenNetSettings}>Net settings</button>}
        </div>
      )}

      {state.kind === "session" && (
        <div className={`notice ${state.reason === "error" ? "notice-error" : "notice-warn"}`} role="status">
          <p>{state.message ?? reasonCopy[state.reason]}</p>
          {state.reason === "signed-out" && onSignIn && <button type="button" className="button button-primary" onClick={onSignIn}>Sign in</button>}
        </div>
      )}
      {state.kind === "ready" && state.truncated && <p className="notice notice-warn">{lifetime ? "Showing your 500 most recently encountered aircraft." : "Only part of the recorded window could be scanned. Counts may be low; try a shorter period."}</p>}

      {state.kind === "ready" && state.patternStatus && state.patternStatus.state !== "ok" && (
        <p className={`notice ${state.patternStatus.state === "failed" ? "notice-error" : "notice-warn"}`} role="status">{state.patternStatus.detail ?? (state.patternStatus.state === "failed" ? "Pattern flags could not be scored right now." : "Pattern flags are incomplete.")}</p>
      )}

      {hasPatterns && (
        <div className="pattern-filter" role="group" aria-label="Filter by review priority">
          <span className="hint">{flaggedCount} flagged for review</span>
          {([["all", "All"], ["flagged", "Flagged"], ["hide-routine", "Hide routine"]] as const).map(([value, label]) => (
            <button key={value} type="button" className="chip-toggle" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
      )}

      {state.kind === "loading" ? (
        <div className="empty-state" role="status"><span className="spinner" aria-hidden="true" /><p>Loading your Netted log…</p></div>
      ) : aircraft.length === 0 && allAircraft.length > 0 ? (
        <div className="empty-state" role="status"><p><strong>Nothing matches this filter.</strong></p><p className="muted">No aircraft currently meet the review thresholds.</p></div>
      ) : aircraft.length === 0 ? (
        <div className="empty-state" role="status">
          <span className="empty-icon" aria-hidden="true">◎</span>
          <p><strong>No aircraft netted yet.</strong></p>
          <p className="muted">Aircraft appear here when they are observed inside {formatRadius(radiusMi)} of your location. {net && net.state !== "paused" ? "The always-on net is logging passes even when the app is closed." : "Turn on “Keep netting when app is closed” in More, or keep AIRIntel open while signed in, to record them."}</p>
        </div>
      ) : (
        <ul className="netted-list" role="list">
          {aircraft.map((item) => {
            const open = expanded === item.icao24;
            const selected = selectedIcao24 === item.icao24;
            return (
              <li key={item.icao24} className={`netted-card${selected ? " is-selected" : ""}`}>
                <div className="netted-top">
                  <button type="button" className="netted-main" aria-pressed={selected} onClick={() => onSelect(item.icao24)}>
                    <span className="netted-callsign mono">{item.callsign ?? <span className="unknown">Unknown</span>}</span>
                    <PatternBadge pattern={item.pattern} />
                    <span className="netted-ident">{item.registration ?? (item.registryRegistration ? `${item.registryRegistration} (FAA)` : "Registration unknown")} · {item.aircraftTypeCode ?? (item.registryModel ? `${item.registryModel} (FAA)` : "Type unknown")}</span>
                  </button>
                  <span className="visit-counter" aria-label={`Entered the radius ${item.visitCount} ${item.visitCount === 1 ? "time" : "times"}${lifetime ? " in total" : ""}`}>
                    <strong className="mono">{item.visitCount}×</strong><small>{lifetime ? (item.visitCount === 1 ? "encounter" : "encounters") : item.visitCount === 1 ? "entry" : "entries"}</small>
                  </span>
                </div>
                <dl className="netted-facts">
                  <div><dt>First seen</dt><dd>{formatLastSeen(item.firstSeenAt, timeZone)}</dd></div>
                  <div><dt>Last seen</dt><dd>{formatLastSeen(item.lastSeenAt, timeZone)}</dd></div>
                  <div><dt>Closest</dt><dd className="mono">{item.closestApproachMi.toFixed(1)} mi</dd></div>
                </dl>
                {item.pattern && <PatternReasons pattern={item.pattern} />}
                <VisitTimeline item={item} timeZone={timeZone} newSince={newSince} defaultOpen={drawer} radiusMi={radiusMi} />
                <button type="button" className="disclosure" aria-expanded={open} aria-controls={`desc-${item.icao24}`} onClick={() => setExpanded(open ? null : item.icao24)}>
                  {open ? "Hide description" : "Aircraft description"}
                </button>
                {open && <div id={`desc-${item.icao24}`} className="netted-description"><AircraftDescription item={item} enabled={profileLookup} /></div>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="fine-print">An entry is counted each time an aircraft is observed inside the radius after being outside it, or after more than 10 minutes without any observation. Calculated from recorded observations only; nothing is estimated between reception gaps.{lifetime ? " Encounter counts are lifetime totals saved to your account, so they stay the same after closing the app and on every device you sign in on." : ""}</p>
    </section>
  );
}

/** Short description built only from sourced data: observed identity + FAA registry profile when available. */
function AircraftDescription({ item, enabled }: { item: NettedAircraft; enabled: boolean }) {
  const profile = useQuery({
    queryKey: ["aircraft-profile", item.icao24],
    queryFn: ({ signal }) => fetchAircraftProfile(item.icao24, signal),
    enabled,
    retry: false,
    staleTime: 10 * 60_000,
  });
  const registry = profile.data?.registryMatch;
  const value = (field: { value: string | null; status: string } | undefined) => field?.value ?? (field?.status === "withheld_or_unavailable" ? "Withheld" : "Unknown");
  const makeModel = registry && (registry.manufacturer.value || registry.model.value) ? [registry.manufacturer.value, registry.model.value].filter(Boolean).join(" ") : null;
  const profileNote = !enabled ? "Registry lookup disabled." : profile.isFetching ? "Looking up the FAA registry profile…"
    : profile.error instanceof AccessDeniedError ? "Registry details need the profile access grant."
      : profile.error instanceof AuthenticationRequiredError ? "Sign in to see registry details."
        : profile.error instanceof ProviderNotConfiguredError ? "Registry profiles are not configured for this deployment."
          : profile.error instanceof ProfileNotFoundError ? "No registry profile is recorded for this aircraft yet."
            : profile.isError ? "Registry profile unavailable right now."
              : registry ? registryAvailabilityNotice(registry) : null;
  return (
    <>
      <dl className="description-grid">
        <div><dt>ICAO24 (Observed)</dt><dd className="mono">{item.icao24.toUpperCase()}</dd></div>
        <div><dt>Registration</dt><dd>{registry?.nNumber.value ?? item.registration ?? item.registryRegistration ?? "Unknown"}</dd></div>
        <div><dt>Type</dt><dd>{makeModel ?? item.aircraftTypeCode ?? "Unknown"}{!makeModel && item.aircraftTypeCode ? <small> provider-reported</small> : null}</dd></div>
        <div><dt>Registered owner</dt><dd>{value(registry?.registeredOwner)}</dd></div>
        <div><dt>Documented operator</dt><dd>{value(profile.data?.operator.documentedOperator)}</dd></div>
      </dl>
      {profileNote && <p className="fine-print" role="status">{profileNote}</p>}
      <p className="fine-print">Registration does not establish who operated or occupied a particular flight.</p>
    </>
  );
}
