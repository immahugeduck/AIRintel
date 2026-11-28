import { encounterReplayWindow, replayIndexAt } from "./domain/replay";
import { useQuery } from "@tanstack/react-query";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchAircraft } from "./api/aircraft";
import { fetchNearbyAircraft, fetchNettedAircraft, fetchRecentTrack, fetchRouteSummary, fetchTrackInsights, searchAircraft } from "./api/history";
import { fetchAircraftProfile } from "./api/profile";
import { AircraftList } from "./components/AircraftList";
import { AircraftProfilePanel } from "./components/AircraftProfilePanel";
import { AccountSummary, AuthForm, AuthPanel } from "./components/AuthPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { EvidenceUploadPanel } from "./components/EvidenceUploadPanel";
import { HistoryIcon, ListIcon, LogIcon, MapIcon, MoreIcon, NetIcon, PinIcon } from "./components/Icons";
import { ControlCircles } from "./components/ControlCircles";
import { LocationPanel } from "./components/LocationPanel";
import { NetControl } from "./components/NetControl";
import { NettedDrawer } from "./components/NettedDrawer";
import { NettedPanel, type NettedState } from "./components/NettedPanel";
import { ReplayPanel } from "./components/ReplayPanel";
import { SelectedDock } from "./components/SelectedDock";
import type { AircraftObservation, TrackPoint } from "./domain/aircraft";
import { NETTED_DEFAULT_HOURS, countRadiusVisits, toNettedDto, type NettedVisit } from "./domain/netted";
import { buildRadiusRows } from "./domain/radius-list";
import { VISIT_GAP_MINUTES, knotsToMph, milesToNm, nmToMiles } from "./domain/units";
import { useFollowMe } from "./lib/use-follow-me";
import { useNet } from "./lib/use-net";
import { useSession } from "./lib/session";
import { loadWatchArea, saveWatchArea, type WatchArea } from "./lib/watch-area";
import { AccessDeniedError, AuthenticationRequiredError, ProviderNotConfiguredError } from "./providers/contracts";

// Leaflet (and its CSS) is only needed once the map renders; keep it out of the entry chunk.
const LiveMap = lazy(() => import("./components/LiveMap").then((module) => ({ default: module.LiveMap })));

const NETTED_LAST_OPENED_KEY = "airintel.nettedLog.lastOpenedAt.v1";
const readLastOpened = (): string | null => { try { return window.localStorage.getItem(NETTED_LAST_OPENED_KEY); } catch { return null; } };
const writeLastOpened = (value: string) => { try { window.localStorage.setItem(NETTED_LAST_OPENED_KEY, value); } catch { /* storage is optional */ } };

export type View = "map" | "aircraft" | "netted" | "history" | "more";
const NAV: { id: View; label: string; icon: () => ReactNode }[] = [
  { id: "map", label: "Map", icon: MapIcon },
  { id: "aircraft", label: "Aircraft", icon: ListIcon },
  { id: "netted", label: "Netted", icon: NetIcon },
  { id: "history", label: "History", icon: HistoryIcon },
  { id: "more", label: "More", icon: MoreIcon },
];

const envNumber = (value: string | undefined, fallback: number) => {
  const parsed = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};
const SESSION_WINDOW_MS = 6 * 3_600_000;

export default function App() {
  const session = useSession();
  const [view, setView] = useState<View>("map");
  const [area, setArea] = useState<WatchArea>(() => loadWatchArea());
  const [mapSettingsOpen, setMapSettingsOpen] = useState(false);
  const [authPrompt, setAuthPrompt] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [selectedIcao24, setSelectedIcao24] = useState<string | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [selectedEntry, setSelectedEntry] = useState("");
  const [replaySnapshot, setReplaySnapshot] = useState<{ icao24: string; visit: NettedVisit } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSince, setDrawerSince] = useState<string | null>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const { latitude, longitude, radiusMi } = area;
  const radiusNm = milesToNm(radiusMi);
  const signedIn = session.status === "signed-in";

  const updateArea = (next: WatchArea) => { setArea(next); saveWatchArea(next); };
  const net = useNet(signedIn, area, updateArea);
  const follow = useFollowMe(area, updateArea);
  const centerMode = area.followMe ? "follow" as const : area.source === "default" ? undefined : "fixed" as const;
  const openDrawer = () => { setDrawerSince(readLastOpened()); setDrawerOpen(true); };
  const closeDrawer = useCallback(() => { setDrawerOpen(false); writeLastOpened(new Date().toISOString()); }, []);
  const replayEncounter = (icao24: string, enteredAt: string) => {
    const visit = netted.data?.aircraft.find((item) => item.icao24 === icao24)?.visits.find((item) => item.enteredAt === enteredAt);
    setReplaySnapshot(visit ? { icao24, visit } : null);
    setSelectedIcao24(icao24); setSelectedEntry(enteredAt); setReplayIndex(0);
    if (drawerOpen) closeDrawer();
    setView("history"); window.scrollTo({ top: 0 });
  };
  const go = (next: View) => { setView(next); window.scrollTo({ top: 0 }); };

  const query = useMemo(() => ({ latitude, longitude, radiusNm }), [latitude, longitude, radiusNm]);
  const pollMs = Math.max(10, envNumber(import.meta.env.VITE_POLL_INTERVAL_SECONDS, 20)) * 1000;
  const aircraft = useQuery({
    queryKey: ["aircraft", query, signedIn, centerMode],
    queryFn: ({ signal }) => fetchAircraft(query, signal, centerMode),
    refetchInterval: pollMs,
    // Polling pauses while the tab is hidden/unfocused and resumes (with an immediate refetch) when it returns.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: (count, error) => !(error instanceof ProviderNotConfiguredError) && count < 2,
  });
  const nearby = useQuery({
    queryKey: ["nearby-aircraft", latitude, longitude, radiusNm],
    queryFn: ({ signal }) => fetchNearbyAircraft({ latitude, longitude, radiusNm, hours: 1 }, signal),
    enabled: signedIn,
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const netted = useQuery({
    queryKey: ["netted-aircraft", latitude, longitude, radiusMi],
    queryFn: ({ signal }) => fetchNettedAircraft({ latitude, longitude, radiusMi, hours: NETTED_DEFAULT_HOURS, scope: "log" }, signal),
    enabled: signedIn,
    refetchInterval: pollMs * 3,
    refetchIntervalInBackground: false,
    retry: false,
  });
  // Newly recorded live observations should show up in the Netted log right away.
  const recordedAt = aircraft.data?.recording === "recorded" ? aircraft.dataUpdatedAt : 0;
  useEffect(() => { if (recordedAt && signedIn) void netted.refetch(); }, [recordedAt]);

  const search = useQuery({ queryKey: ["aircraft-search", submittedSearch], queryFn: ({ signal }) => searchAircraft(submittedSearch, signal), enabled: submittedSearch.length >= 2, retry: false });
  const historyEnabled = selectedIcao24 !== null && view === "history";
  const selectedLogAircraft = netted.data?.aircraft.find((item) => item.icao24 === selectedIcao24);
  const snapshotVisit = replaySnapshot?.icao24 === selectedIcao24 ? replaySnapshot.visit : undefined;
  const replayVisits = selectedLogAircraft?.visits ?? (snapshotVisit ? [snapshotVisit] : []);
  const selectedVisit = replayVisits.find((visit) => visit.enteredAt === selectedEntry) ?? (snapshotVisit?.enteredAt === selectedEntry ? snapshotVisit : undefined);
  const track = useQuery({
    queryKey: ["recent-track", selectedIcao24, selectedVisit?.enteredAt ?? null, signedIn],
    queryFn: ({ signal }) => fetchRecentTrack(selectedIcao24!, signal, selectedVisit ? encounterReplayWindow(selectedVisit) : undefined),
    enabled: selectedIcao24 !== null && signedIn,
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const priorTrack = useRef<{ key: string; points: TrackPoint[] } | null>(null);
  useEffect(() => {
    if (!track.data) return;
    const key = `${selectedIcao24}:${selectedEntry}`;
    const previous = priorTrack.current;
    if (previous?.key === key) {
      const at = previous.points[replayIndex]?.observedAt;
      if (at) setReplayIndex(replayIndexAt(track.data.points.map((point) => Date.parse(point.observedAt)), Date.parse(at)));
    }
    priorTrack.current = { key, points: track.data.points };
  }, [track.data]);
  const profile = useQuery({ queryKey: ["aircraft-profile", selectedIcao24], queryFn: ({ signal }) => fetchAircraftProfile(selectedIcao24!, signal), enabled: historyEnabled, retry: false });
  const insights = useQuery({ queryKey: ["track-insights", selectedIcao24], queryFn: ({ signal }) => fetchTrackInsights({ icao24: selectedIcao24!, hours: 24 }, signal), enabled: historyEnabled, retry: false });
  const routeSummary = useQuery({ queryKey: ["route-summary", selectedIcao24], queryFn: ({ signal }) => fetchRouteSummary({ icao24: selectedIcao24!, hours: 24 }, signal), enabled: historyEnabled, retry: false });

  // Real live observations seen during this visit (bounded), used for the session-only netted fallback.
  const areaKey = `${latitude}:${longitude}:${radiusMi}`;
  const [sessionObs, setSessionObs] = useState<{ area: string; observations: AircraftObservation[] }>({ area: areaKey, observations: [] });
  useEffect(() => {
    setSessionObs((previous) => {
      const cutoff = Date.now() - SESSION_WINDOW_MS;
      const seen = new Map<string, AircraftObservation>();
      for (const item of [...(previous.area === areaKey ? previous.observations : []), ...(aircraft.data?.observations ?? [])]) {
        if (Date.parse(item.observedAt) >= cutoff) seen.set(`${item.icao24}:${item.observedAt}`, item);
      }
      return { area: areaKey, observations: [...seen.values()].slice(-20_000) };
    });
  }, [aircraft.data, areaKey]);

  const radiusRows = useMemo(
    () => buildRadiusRows(aircraft.data?.observations ?? [], nearby.data?.matches ?? [], { latitude, longitude }, radiusNm),
    [aircraft.data, nearby.data, latitude, longitude, radiusNm],
  );

  const nettedState: NettedState = useMemo(() => {
    const sessionList = () => {
      const typeCodes = new Map<string, string>();
      for (const item of sessionObs.observations) if (item.aircraftTypeCode) typeCodes.set(item.icao24, item.aircraftTypeCode);
      return countRadiusVisits(sessionObs.observations, { latitude, longitude, radiusNm, gapMinutes: VISIT_GAP_MINUTES })
        .map((summary) => toNettedDto(summary, typeCodes.get(summary.icao24) ?? null));
    };
    if (session.status === "unconfigured") return { kind: "session", reason: "unconfigured", aircraft: sessionList() };
    if (session.status === "checking") return { kind: "loading" };
    if (!signedIn) return { kind: "session", reason: "signed-out", aircraft: sessionList() };
    if (netted.data) return { kind: "ready", source: "recorded", aircraft: netted.data.aircraft, hours: netted.data.query.hours, truncated: netted.data.truncated, net: netted.data.net ?? net.status, lifetime: netted.data.source === "log", patternStatus: netted.data.patternStatus ?? null };
    if (netted.error instanceof AccessDeniedError) return { kind: "session", reason: "no-access", aircraft: sessionList() };
    if (netted.error instanceof AuthenticationRequiredError) return { kind: "session", reason: "signed-out", aircraft: sessionList() };
    if (netted.error instanceof ProviderNotConfiguredError) return { kind: "session", reason: "unconfigured", aircraft: sessionList() };
    if (netted.isError) return { kind: "session", reason: "error", aircraft: sessionList() };
    return { kind: "loading" };
  }, [session.status, signedIn, netted.data, netted.error, netted.isError, sessionObs, latitude, longitude, radiusNm]);

  // Badge: entries (visits) that began in the last 24 h.
  const entries24h = useMemo(() => {
    if (nettedState.kind === "loading") return 0;
    const cutoff = Date.now() - 24 * 3_600_000;
    return nettedState.aircraft.reduce((sum, item) => sum + item.visits.filter((visit) => Date.parse(visit.enteredAt) >= cutoff).length, 0);
  }, [nettedState]);
  const openNetSettings = () => { closeDrawerIfOpen(); go("more"); };
  const closeDrawerIfOpen = () => { if (drawerOpen) closeDrawer(); };

  const selectedRow = radiusRows.find((row) => row.icao24 === selectedIcao24) ?? null;
  const selectedNetted = nettedState.kind === "loading" ? null : nettedState.aircraft.find((item) => item.icao24 === selectedIcao24) ?? null;
  const selectAircraft = (icao24: string) => { setSelectedIcao24(icao24); setSelectedEntry(""); setReplaySnapshot(null); setReplayIndex(0); };

  const feedState = aircraft.error instanceof ProviderNotConfiguredError ? { label: "Feed not configured", tone: "warn" } : aircraft.isError ? { label: "Feed unavailable", tone: "error" } : aircraft.isPending ? { label: "Connecting…", tone: "idle" } : { label: "Live", tone: "ok" };
  const liveError = aircraft.error instanceof ProviderNotConfiguredError ? "No live aircraft provider is configured for this deployment. No aircraft are invented." : aircraft.isError ? aircraft.error.message : null;
  const recordedNote = !signedIn ? null : nearby.error instanceof AccessDeniedError ? "Recorded aircraft need the history access grant; showing live aircraft only." : nearby.isError ? "Recorded aircraft are unavailable; showing live aircraft only." : null;
  const recordingNote = aircraft.data?.recording === "recorded" ? "Recording to your Netted log" : aircraft.data?.recording === "no_history_access" ? "Not recording: history access needed" : null;

  return (
    <div className="app-shell" data-view={view}>
      <header className="topbar">
        <div className="brand"><img className="brand-logo" src="/airintel-logo.svg" alt="" aria-hidden="true" /><div className="brand-copy"><strong>AIRIntel</strong><span>Air Route Intelligence</span></div></div>
        <span className={`status-pill is-${feedState.tone}`} role="status" title={feedState.label}><span className="pulse" aria-hidden="true" /><span className="status-label">{feedState.label}</span></span>
        <button ref={drawerTriggerRef} type="button" className="icon-button log-button" onClick={openDrawer} aria-haspopup="dialog" aria-expanded={drawerOpen} aria-label={`Netted log${entries24h > 0 ? `, ${entries24h} ${entries24h === 1 ? "entry" : "entries"} in the last 24 hours` : ""}`}>
          <LogIcon />
          {entries24h > 0 && <span className="log-badge mono" aria-hidden="true">{entries24h > 99 ? "99+" : entries24h}</span>}
        </button>
        <AuthPanel key={authPrompt} defaultOpen={authPrompt > 0} />
      </header>

      <nav className="app-nav" aria-label="Main">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className="nav-item" aria-current={view === id ? "page" : undefined} onClick={() => go(id)}>
            <Icon /><span>{label}</span>
            {id === "aircraft" && radiusRows.length > 0 && <span className="nav-badge" aria-label={`${radiusRows.length} aircraft`}>{radiusRows.length}</span>}
          </button>
        ))}
      </nav>

      <main id="main" className="app-main">
        <div className="map-region">
          <div className="map-overlay-top">
            <button type="button" className="watch-chip" onClick={() => go("more")}>
              <PinIcon /><span>{view === "history" && selectedVisit ? "Saved encounter center" : area.source === "device" ? "My location" : area.source === "saved" ? "Saved location" : "Default area"} · {radiusMi} mi</span>
            </button>
            {recordingNote && <span className="status-pill is-ok small">{recordingNote}</span>}
          </div>
          <ErrorBoundary label="The map">
            <Suspense fallback={<div className="map-loading" role="status"><span className="spinner" aria-hidden="true" /> Loading map…</div>}>
              <LiveMap id="live-feed" settingsOpen={mapSettingsOpen} onSettingsOpenChange={setMapSettingsOpen} center={view === "history" && selectedVisit?.centerLatitude != null && selectedVisit.centerLongitude != null ? [selectedVisit.centerLatitude, selectedVisit.centerLongitude] : [latitude, longitude]} observations={aircraft.data?.observations ?? []} selectedIcao24={selectedIcao24} onSelectAircraft={selectAircraft} radiusMi={view === "history" && selectedVisit ? selectedVisit.radiusMi ?? radiusMi : radiusMi} trackPoints={track.data?.points ?? []} replayIndex={replayIndex} />
            </Suspense>
          </ErrorBoundary>
        </div>

        <div className="content-region">
          <ErrorBoundary key={view} label="This view">
          {(view === "map" || view === "aircraft") && (
            <div className={view === "map" ? "desktop-only" : undefined}>
              <AircraftList rows={radiusRows} selectedIcao24={selectedIcao24} onSelect={selectAircraft} radiusMi={radiusMi} loading={aircraft.isPending || (signedIn && nearby.isPending)} liveError={liveError} recordedNote={recordedNote} />
            </div>
          )}
          {view === "netted" && <NettedPanel onReplay={replayEncounter} state={nettedState} radiusMi={radiusMi} selectedIcao24={selectedIcao24} onSelect={selectAircraft} onSignIn={() => setAuthPrompt((value) => value + 1)} onOpenNetSettings={() => go("more")} />}
          {view === "history" && (
            <div className="stack-lg">
              <section className="panel" aria-labelledby="search-heading">
                <header className="panel-header"><div><p className="eyebrow">Recorded aircraft</p><h2 id="search-heading">Search history</h2></div></header>
                <form className="search-form" role="search" onSubmit={(event) => { event.preventDefault(); setSubmittedSearch(searchInput.trim()); }}>
                  <label htmlFor="history-search" className="sr-only">Registration, ICAO24 or call sign</label>
                  <input id="history-search" type="search" inputMode="search" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="search" value={searchInput} minLength={2} maxLength={24} pattern="[A-Za-z0-9\-]+" placeholder="N123AB, a1b2c3 or SWA123" onChange={(event) => setSearchInput(event.currentTarget.value)} />
                  <button type="submit" className="button button-primary">Search</button>
                </form>
                {submittedSearch && (
                  <div aria-live="polite" className="search-results">
                    {search.error instanceof ProviderNotConfiguredError ? <p className="notice notice-warn">Recorded history is not configured. No recorded aircraft are fabricated.</p>
                      : search.error instanceof AuthenticationRequiredError ? <p className="notice notice-warn">Sign in to search recorded aircraft.</p>
                        : search.error instanceof AccessDeniedError ? <p className="notice notice-warn">Your account needs the history access grant to search.</p>
                          : search.isError ? <p className="notice notice-error" role="alert">{search.error.message}</p>
                            : search.isFetching ? <p className="notice"><span className="spinner" aria-hidden="true" /> Searching recorded observations…</p>
                              : search.data?.aircraft.length === 0 ? <p className="empty-inline">No matching aircraft have been recorded.</p>
                                : <ul className="result-list">{search.data?.aircraft.map((item) => <li key={item.id}><button type="button" className="result-item" aria-pressed={selectedIcao24 === item.icao24} onClick={() => selectAircraft(item.icao24)}><strong className="mono">{item.registration ?? item.icao24.toUpperCase()}</strong><span>{item.icao24.toUpperCase()} · last seen {new Date(item.lastSeenAt).toLocaleString()}</span></button></li>)}</ul>}
                  </div>
                )}
              </section>
              {!selectedIcao24 ? <p className="empty-inline">Select an aircraft from the map, the Aircraft list, Netted or a search result to see its replay and profile.</p> : (
                <>
                  {!signedIn && <p className="notice notice-warn">Sign in to replay saved observations.</p>}
                  <label htmlFor="encounter-replay">Recorded encounter</label>
                  <select id="encounter-replay" value={selectedVisit?.enteredAt ?? ""} onChange={(event) => { const visit = replayVisits.find((entry) => entry.enteredAt === event.target.value); setReplaySnapshot(visit && selectedIcao24 ? { icao24: selectedIcao24, visit } : null); setSelectedEntry(event.target.value); setReplayIndex(0); }}>
                    <option value="">All recorded observations · last 24 hours</option>
                    {replayVisits.map((visit) => <option key={visit.enteredAt} value={visit.enteredAt}>{new Date(visit.enteredAt).toLocaleString()} · {visit.observationCount} inside sightings</option>)}
                  </select>
                  {selectedVisit && <p className="fine-print">Includes up to 10 minutes of recorded approach and departure on either side, within a 24-hour request. Coverage depends on collection and retention. {selectedVisit.centerLatitude == null ? "Historical center unknown." : "Map uses the saved entry center; follow-me may have moved during this encounter."}</p>}
                  {track.isFetching && track.data && <p role="status" className="fine-print">Refreshing recorded observations…</p>}
                  {track.isError && track.data && <p role="status" className="notice notice-warn">Refresh failed. Showing the last loaded track.</p>}
                  {track.data?.coverage.truncated && <p className="notice notice-warn">Track limited to the newest 10,000 recorded points in this window.</p>}
                  {track.isFetching && !track.data ? <p className="notice"><span className="spinner" aria-hidden="true" /> Loading recorded observations…</p>
                    : !track.data && track.error instanceof AuthenticationRequiredError ? <p className="notice notice-warn">Sign in to replay recorded tracks.</p>
                      : !track.data && track.error instanceof AccessDeniedError ? <p className="notice notice-warn">Replay needs the history access grant.</p>
                        : !track.data && track.error instanceof ProviderNotConfiguredError ? <p className="notice notice-warn">Recorded history is not configured.</p>
                          : !track.data && track.isError ? <p className="notice notice-error" role="alert">Track unavailable: {track.error.message}</p>
                            : track.data?.points.length === 0 ? <p className="empty-inline">No retained observations are available in this replay window.</p>
                              : track.data ? <ReplayPanel visit={selectedVisit} key={`${selectedIcao24}:${selectedEntry}`} title={selectedVisit ? "Encounter replay + approach/departure" : "24-hour replay"} points={track.data.points} aircraftLabel={track.data.aircraft.registration ?? track.data.aircraft.icao24} index={replayIndex} onIndexChange={setReplayIndex} /> : null}
                  {insights.data && (
                    <section className="replay" aria-labelledby="insights-heading">
                      <div className="replay-title"><div><p className="eyebrow">Track insights</p><h3 id="insights-heading">Last 24 hours</h3></div><span>{insights.data.summary.pointCount} points</span></div>
                      <dl className="replay-facts">
                        <div><dt>Sources</dt><dd>{insights.data.summary.sourceCount}</dd></div>
                        <div><dt>Altitude range</dt><dd>{insights.data.summary.altitudeFt.min == null ? "Unknown" : `${Math.round(insights.data.summary.altitudeFt.min).toLocaleString()}–${Math.round(insights.data.summary.altitudeFt.max ?? insights.data.summary.altitudeFt.min).toLocaleString()} ft`}</dd></div>
                        <div><dt>Average speed</dt><dd>{insights.data.summary.groundSpeedKt.average == null ? "Unknown" : `${Math.round(knotsToMph(insights.data.summary.groundSpeedKt.average))} mph`}</dd></div>
                      </dl>
                    </section>
                  )}
                  {routeSummary.data && (
                    <section className="replay" aria-labelledby="route-summary-heading">
                      <div className="replay-title"><div><p className="eyebrow">Route analytics</p><h3 id="route-summary-heading">Path summary</h3></div><span>{routeSummary.data.summary.loiteringDetected ? "Loitering" : "Transit"}</span></div>
                      <dl className="replay-facts">
                        <div><dt>Duration</dt><dd>{Math.round(routeSummary.data.summary.durationMinutes)} min</dd></div>
                        <div><dt>Distance</dt><dd>{nmToMiles(routeSummary.data.summary.totalDistanceNm).toFixed(1)} mi</dd></div>
                        <div><dt>Loitering</dt><dd>{routeSummary.data.summary.loiteringDetected ? `${Math.round(routeSummary.data.summary.loiteringMinutes)} min` : "None"}</dd></div>
                      </dl>
                    </section>
                  )}
                  {profile.isFetching ? <p className="notice"><span className="spinner" aria-hidden="true" /> Building the sourced profile…</p>
                    : profile.error instanceof AccessDeniedError ? <p className="notice notice-warn">Aircraft profiles need the profile access grant.</p>
                      : profile.error instanceof AuthenticationRequiredError ? <p className="notice notice-warn">Sign in to see aircraft profiles.</p>
                        : profile.error instanceof ProviderNotConfiguredError ? <p className="notice notice-warn">Aircraft profiles are not configured. No profile facts are fabricated.</p>
                          : profile.isError ? <p className="notice notice-error" role="alert">Aircraft profile unavailable: {profile.error.message}</p>
                            : profile.data ? <AircraftProfilePanel profile={profile.data} /> : null}
                </>
              )}
            </div>
          )}
          {view === "more" && (
            <div className="stack-lg">
              <LocationPanel area={area} onChange={updateArea} follow={follow} />
              <NetControl state={net.state} area={area} saving={net.saving} saveError={net.saveError} onToggle={(enabled) => void net.setEnabled(enabled)} onSignIn={() => setAuthPrompt((value) => value + 1)} />
              <ControlCircles signedIn={signedIn} onSignIn={() => setAuthPrompt((value) => value + 1)} />
              <section className="panel" aria-labelledby="account-heading">
                <header className="panel-header"><div><p className="eyebrow">Neon Auth</p><h2 id="account-heading">Account</h2></div></header>
                {signedIn ? <AccountSummary /> : <AuthForm />}
              </section>
              <section className="panel" aria-labelledby="map-settings-heading">
                <header className="panel-header"><div><p className="eyebrow">Basemap</p><h2 id="map-settings-heading">Map settings</h2></div></header>
                <p className="muted">Connect a public Mapbox token and choose a style. Stored only on this device.</p>
                <button type="button" className="button button-ghost" onClick={() => setMapSettingsOpen(true)}>Open map settings</button>
              </section>
              <details className="panel evidence-details"><summary>Add supporting evidence</summary><EvidenceUploadPanel /></details>
              <p className="fine-print about">Times are shown in your device's time zone; data is stored in UTC. Distances in statute miles, altitude in feet, speed in mph (converted from ground speed in knots). Live data: adsb.lol (ODbL); when it is unreachable, <a href="https://adsb.fi" target="_blank" rel="noreferrer">adsb.fi</a> or airplanes.live (each aircraft shows its source).</p>
            </div>
          )}
          </ErrorBoundary>
        </div>
      </main>

      <NettedDrawer open={drawerOpen} onClose={closeDrawer} title="Netted log" subtitle={`Entries into your ${radiusMi} mi radius`}>
        <NettedPanel onReplay={replayEncounter} variant="drawer" state={nettedState} radiusMi={radiusMi} selectedIcao24={selectedIcao24} newSince={drawerSince} onSelect={(icao24) => { selectAircraft(icao24); }} onSignIn={() => { closeDrawer(); setAuthPrompt((value) => value + 1); }} onOpenNetSettings={openNetSettings} />
      </NettedDrawer>

      {selectedIcao24 && view !== "history" && view !== "more" && (
        <SelectedDock
          icao24={selectedIcao24}
          row={selectedRow}
          netted={selectedNetted}
          onClose={() => setSelectedIcao24(null)}
          onShowMap={view === "map" ? undefined : () => go("map")}
          onDetails={() => go("history")}
        />
      )}
    </div>
  );
}
