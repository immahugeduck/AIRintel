import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ProfileNotFoundError, fetchAircraftProfile } from "../api/profile";
import type { NettedAircraft } from "../domain/netted";
import { formatLastSeen } from "../domain/units";
import { AccessDeniedError, AuthenticationRequiredError, ProviderNotConfiguredError } from "../providers/contracts";
import { formatRadius } from "./AircraftList";

export type NettedState =
  | { kind: "loading" }
  | { kind: "ready"; aircraft: NettedAircraft[]; hours: number; truncated: boolean; source: "recorded" }
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
};

const reasonCopy: Record<Extract<NettedState, { kind: "session" }>["reason"], string> = {
  "signed-out": "Sign in to keep a saved Netted log. Until then, only aircraft seen during this visit are counted, and they are not saved.",
  "no-access": "Your account does not have the history access grant yet, so the saved Netted log is unavailable. The owner can grant it with npm run access:grant -- --email <you> --scope history. Showing this visit only.",
  unconfigured: "Recorded history is not configured for this deployment (database or sign-in missing). Showing this visit only; nothing is saved.",
  error: "The saved Netted log could not be loaded. Showing this visit only.",
};

/** Aircraft netted inside the watch radius with a visit counter and a short sourced description. */
export function NettedPanel({ state, radiusMi, selectedIcao24, onSelect, onSignIn, timeZone, profileLookup = true }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const aircraft = state.kind === "loading" ? [] : state.aircraft;
  const totalVisits = aircraft.reduce((sum, item) => sum + item.visitCount, 0);

  return (
    <section className="panel netted" aria-labelledby="netted-heading">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Entered my {formatRadius(radiusMi)} radius{state.kind === "ready" ? ` · last ${state.hours >= 48 ? `${Math.round(state.hours / 24)} days` : `${state.hours} h`}` : state.kind === "session" ? " · this visit" : ""}</p>
          <h2 id="netted-heading">Netted aircraft <span className="count-badge" aria-label={`${aircraft.length} aircraft`}>{aircraft.length}</span></h2>
        </div>
        {aircraft.length > 0 && <span className="hint">{totalVisits} {totalVisits === 1 ? "entry" : "entries"}</span>}
      </header>

      {state.kind === "session" && (
        <div className={`notice ${state.reason === "error" ? "notice-error" : "notice-warn"}`} role="status">
          <p>{state.message ?? reasonCopy[state.reason]}</p>
          {state.reason === "signed-out" && onSignIn && <button type="button" className="button button-primary" onClick={onSignIn}>Sign in</button>}
        </div>
      )}
      {state.kind === "ready" && state.truncated && <p className="notice notice-warn">Only part of the recorded window could be scanned. Counts may be low; try a shorter period.</p>}

      {state.kind === "loading" ? (
        <div className="empty-state" role="status"><span className="spinner" aria-hidden="true" /><p>Loading your Netted log…</p></div>
      ) : aircraft.length === 0 ? (
        <div className="empty-state" role="status">
          <span className="empty-icon" aria-hidden="true">◎</span>
          <p><strong>No aircraft netted yet.</strong></p>
          <p className="muted">Aircraft appear here when they are observed inside {formatRadius(radiusMi)} of your location. Keep AIRIntel open while signed in to record them.</p>
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
                    <span className="netted-ident">{item.registration ?? "Registration unknown"} · {item.aircraftTypeCode ?? "Type unknown"}</span>
                  </button>
                  <span className="visit-counter" aria-label={`Entered the radius ${item.visitCount} ${item.visitCount === 1 ? "time" : "times"}`}>
                    <strong className="mono">{item.visitCount}×</strong><small>{item.visitCount === 1 ? "entry" : "entries"}</small>
                  </span>
                </div>
                <dl className="netted-facts">
                  <div><dt>First seen</dt><dd>{formatLastSeen(item.firstSeenAt, timeZone)}</dd></div>
                  <div><dt>Last seen</dt><dd>{formatLastSeen(item.lastSeenAt, timeZone)}</dd></div>
                  <div><dt>Closest</dt><dd className="mono">{item.closestApproachMi.toFixed(1)} mi</dd></div>
                </dl>
                <button type="button" className="disclosure" aria-expanded={open} aria-controls={`desc-${item.icao24}`} onClick={() => setExpanded(open ? null : item.icao24)}>
                  {open ? "Hide description" : "Aircraft description"}
                </button>
                {open && <div id={`desc-${item.icao24}`} className="netted-description"><AircraftDescription item={item} enabled={profileLookup} /></div>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="fine-print">An entry is counted each time an aircraft is observed inside the radius after being outside it, or after more than 10 minutes without any observation. Calculated from recorded observations only; nothing is estimated between reception gaps.</p>
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
            : profile.isError ? "Registry profile unavailable right now." : null;
  return (
    <>
      <dl className="description-grid">
        <div><dt>ICAO24 (Observed)</dt><dd className="mono">{item.icao24.toUpperCase()}</dd></div>
        <div><dt>Registration</dt><dd>{registry?.nNumber.value ?? item.registration ?? "Unknown"}</dd></div>
        <div><dt>Type</dt><dd>{makeModel ?? item.aircraftTypeCode ?? "Unknown"}{!makeModel && item.aircraftTypeCode ? <small> provider-reported</small> : null}</dd></div>
        <div><dt>Registered owner</dt><dd>{value(registry?.registeredOwner)}</dd></div>
        <div><dt>Documented operator</dt><dd>{value(profile.data?.operator.documentedOperator)}</dd></div>
      </dl>
      {profileNote && <p className="fine-print" role="status">{profileNote}</p>}
      <p className="fine-print">Registration does not establish who operated or occupied a particular flight.</p>
    </>
  );
}
