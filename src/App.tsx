import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { fetchAircraft } from "./api/aircraft";
import { fetchNearbyAircraft, fetchRecentTrack, fetchRouteSummary, fetchTrackInsights, searchAircraft } from "./api/history";
import { fetchAircraftProfile } from "./api/profile";
import { AircraftProfilePanel } from "./components/AircraftProfilePanel";
import { AuthPanel } from "./components/AuthPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LiveMap } from "./components/LiveMap";
import { EvidenceUploadPanel } from "./components/EvidenceUploadPanel";
import { ReplayPanel } from "./components/ReplayPanel";
import { distanceNm } from "./domain/geometry";
import type { AircraftObservation } from "./domain/aircraft";
import { AuthenticationRequiredError, ProviderNotConfiguredError } from "./providers/contracts";

const envNumber = (value: string | undefined, fallback: number) => {
  const parsed = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};


export default function App() {
  const [latitude, setLatitude] = useState(Math.max(-90, Math.min(90, envNumber(import.meta.env.VITE_DEFAULT_CENTER_LAT, 39.7684))));
  const [longitude, setLongitude] = useState(Math.max(-180, Math.min(180, envNumber(import.meta.env.VITE_DEFAULT_CENTER_LON, -86.1581))));
  const [radiusNm, setRadiusNm] = useState(Math.max(1, Math.min(100, envNumber(import.meta.env.VITE_DEFAULT_RADIUS_NM, 20))));
  const [searchInput, setSearchInput] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [selectedIcao24, setSelectedIcao24] = useState<string | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [activeSection, setActiveSection] = useState("live-feed");
  const query = useMemo(() => ({ latitude, longitude, radiusNm }), [latitude, longitude, radiusNm]);
  const pollMs = Math.max(10, envNumber(import.meta.env.VITE_POLL_INTERVAL_SECONDS, 20)) * 1000;
  const aircraft = useQuery({
    queryKey: ["aircraft", query],
    queryFn: ({ signal }) => fetchAircraft(query, signal),
    refetchInterval: pollMs,
    retry: (count, error) => !(error instanceof ProviderNotConfiguredError) && count < 2,
  });
  const search = useQuery({
    queryKey: ["aircraft-search", submittedSearch],
    queryFn: ({ signal }) => searchAircraft(submittedSearch, signal),
    enabled: submittedSearch.length >= 2,
    retry: false,
  });
  const track = useQuery({
    queryKey: ["recent-track", selectedIcao24],
    queryFn: ({ signal }) => fetchRecentTrack(selectedIcao24!, signal),
    enabled: selectedIcao24 !== null,
    retry: false,
  });
  const profile = useQuery({
    queryKey: ["aircraft-profile", selectedIcao24],
    queryFn: ({ signal }) => fetchAircraftProfile(selectedIcao24!, signal),
    enabled: selectedIcao24 !== null,
    retry: false,
  });
  const insights = useQuery({
    queryKey: ["track-insights", selectedIcao24],
    queryFn: ({ signal }) => fetchTrackInsights({ icao24: selectedIcao24!, hours: 24 }, signal),
    enabled: selectedIcao24 !== null,
    retry: false,
  });
  const routeSummary = useQuery({
    queryKey: ["route-summary", selectedIcao24],
    queryFn: ({ signal }) => fetchRouteSummary({ icao24: selectedIcao24!, hours: 24 }, signal),
    enabled: selectedIcao24 !== null,
    retry: false,
  });
  const nearby = useQuery({
    queryKey: ["nearby-aircraft", latitude, longitude, radiusNm],
    queryFn: ({ signal }) => fetchNearbyAircraft({ latitude, longitude, radiusNm, hours: 24 }, signal),
    enabled: true,
    refetchInterval: pollMs,
    retry: false,
  });


  const areaKey = `${latitude}:${longitude}:${radiusNm}`;
  const [visited, setVisited] = useState<{ area: string; observations: AircraftObservation[] }>({ area: areaKey, observations: [] });
  useEffect(() => {
    setVisited((previous) => {
      const rows = new Map<string, AircraftObservation>();
      for (const observation of [...(previous.area === areaKey ? previous.observations : []), ...(aircraft.data?.observations ?? [])]) {
        if (distanceNm(latitude, longitude, observation.latitude, observation.longitude) > radiusNm) continue;
        const old = rows.get(observation.icao24);
        if (!old || Date.parse(observation.observedAt) > Date.parse(old.observedAt)) rows.set(observation.icao24, observation);
      }
      return { area: areaKey, observations: [...rows.values()] };
    });
  }, [aircraft.data, areaKey, latitude, longitude, radiusNm]);
  const radiusAircraft = useMemo(() => {
    type Row = { icao24: string; registration?: string | null | undefined; callsign?: string | null | undefined; altitudeFt?: number | null | undefined; altitudeSource?: string | null | undefined; groundSpeedKt?: number | null | undefined; trackDeg?: number | null | undefined; observedAt: string; distanceNm: number; source: string };
    const rows = new Map<string, Row>();
    for (const item of nearby.data?.matches ?? []) {
      const distance = distanceNm(latitude, longitude, item.latitude, item.longitude);
      if (distance <= radiusNm) {
        const old = rows.get(item.icao24);
        if (!old || Date.parse(item.observedAt) > Date.parse(old.observedAt)) rows.set(item.icao24, { ...item, distanceNm: distance, source: "Recorded" });
      }
    }
    for (const item of visited.area === areaKey ? visited.observations : []) {
      const old = rows.get(item.icao24);
      if (!old || Date.parse(item.observedAt) >= Date.parse(old.observedAt)) rows.set(item.icao24, { ...item, distanceNm: distanceNm(latitude, longitude, item.latitude, item.longitude), source: item.provider });
    }
    return [...rows.values()].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  }, [nearby.data, visited, areaKey, latitude, longitude, radiusNm]);
  const selectedObservation = aircraft.data?.observations.find((item) => item.icao24 === selectedIcao24) ?? radiusAircraft.find((item) => item.icao24 === selectedIcao24);
  const selectAircraft = (icao24: string) => { setSelectedIcao24(icao24); setReplayIndex(0); };

  const sourceState = aircraft.error instanceof ProviderNotConfiguredError ? "Configuration required" : aircraft.isError ? "Feed unavailable" : aircraft.isFetching ? "Refreshing" : "Connected";
  const selectedLabel = selectedIcao24 ? selectedIcao24.toUpperCase() : "None";

  const goToSection = (sectionId: string) => {
    setActiveSection(sectionId);
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-group">
          <div className="brand-mark" aria-hidden="true">AI</div>
          <div className="brand-copy"><strong>AIRIntel</strong><span>AirRoute Intelligence</span></div>
        </div>
        <label className="section-switcher" htmlFor="page-jump">
          <span>View</span>
          <select id="page-jump" value={activeSection} onChange={(event) => goToSection(event.currentTarget.value)}>
            <option value="live-feed">Map</option>
            <option value="radius-aircraft">Aircraft in radius</option>
            <option value="history-search-panel">Search</option>
            <option value="analytics">Analytics</option>
          </select>
        </label>
        <AuthPanel />
        <div className="system-state"><span className="pulse" />{sourceState}</div>
      </header>
      <main id="main">
        <section className="airspace-toolbar" aria-label="Watch area controls">
          <div className="query-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Watch area</p>
                <h2>Airspace</h2>
              </div>
              <button type="button" className="ghost-button" onClick={() => void aircraft.refetch()} disabled={aircraft.isFetching}>Refresh</button>
            </div>
            <div className="query-bar">
              <label>Latitude<input type="number" value={latitude} min={-90} max={90} step="0.0001" onChange={(e) => { const value = e.currentTarget.valueAsNumber; if (Number.isFinite(value) && value >= -90 && value <= 90) setLatitude(value); }} /></label>
              <label>Longitude<input type="number" value={longitude} min={-180} max={180} step="0.0001" onChange={(e) => { const value = e.currentTarget.valueAsNumber; if (Number.isFinite(value) && value >= -180 && value <= 180) setLongitude(value); }} /></label>
              <label>Radius (NM)<input type="number" value={radiusNm} min={1} max={100} onChange={(e) => { const value = e.currentTarget.valueAsNumber; if (Number.isFinite(value) && value >= 1 && value <= 100) setRadiusNm(value); }} /></label>
            </div>
          </div>

        </section>
        <div className="workspace-grid">
          <ErrorBoundary><LiveMap id="live-feed" center={[latitude, longitude]} observations={aircraft.data?.observations ?? []} selectedIcao24={selectedIcao24} onSelectAircraft={selectAircraft} radiusNm={radiusNm} trackPoints={track.data?.points ?? []} replayIndex={replayIndex} /></ErrorBoundary>

        </div>

        <section className="radius-panel section-panel" id="radius-aircraft" aria-labelledby="radius-heading">
          <div className="panel-heading"><div><p className="eyebrow">Observed within {radiusNm} NM</p><h2 id="radius-heading">Aircraft in your radius <span className="count">{radiusAircraft.length}</span></h2></div><span className="table-window">This session + available records from the last 24 hours</span></div>
          {aircraft.isError && <p className="track-error" role="alert">Live feed: {aircraft.error.message}</p>}
          {nearby.isError && <p className="table-note">Recorded radius history unavailable. Showing aircraft observed during this session.</p>}
          <div className="aircraft-table-scroll">
            <table className="aircraft-table"><caption className="table-note">One row per aircraft. Distance and flight values refer to its latest available observation inside this radius. Select a row for details.</caption>
              <thead><tr><th scope="col">#</th><th scope="col">Aircraft</th><th scope="col">Callsign</th><th scope="col">Distance (NM)</th><th scope="col">Altitude (ft)</th><th scope="col">Speed (kt)</th><th scope="col">Track (°)</th><th scope="col">Last seen (UTC)</th><th scope="col">Source</th></tr></thead>
              <tbody>{radiusAircraft.map((item, index) => <tr key={item.icao24} className={item.icao24 === selectedIcao24 ? "selected" : ""} onClick={() => selectAircraft(item.icao24)}>
                <td>{index + 1}</td><td><button type="button" aria-pressed={item.icao24 === selectedIcao24} onClick={() => selectAircraft(item.icao24)}>{item.registration ?? item.icao24.toUpperCase()}</button><small>{item.icao24.toUpperCase()}</small></td>
                <td>{item.callsign ?? "—"}</td><td>{item.distanceNm.toFixed(1)}</td><td>{item.altitudeFt == null ? "—" : `${Math.round(item.altitudeFt).toLocaleString()} ${item.altitudeSource ?? ""}`}</td><td>{item.groundSpeedKt == null ? "—" : Math.round(item.groundSpeedKt)}</td><td>{item.trackDeg == null ? "—" : Math.round(item.trackDeg)}</td><td>{new Date(item.observedAt).toISOString().replace("T", " ").slice(0, 19)}</td><td>{item.source}</td>
              </tr>)}</tbody>
            </table>
          </div>
          {radiusAircraft.length === 0 && <p className="table-note" role="status">{aircraft.isFetching || nearby.isFetching ? "Loading aircraft…" : "No aircraft observations available within this radius."}</p>}
        </section>
        {selectedIcao24 && <section className="selected-flight section-panel" aria-label="Selected aircraft">
          <div className="panel-heading"><div><p className="eyebrow">Selected aircraft</p><h2>{selectedObservation?.registration ?? selectedObservation?.callsign ?? selectedLabel}</h2></div><button type="button" className="ghost-button" onClick={() => setSelectedIcao24(null)}>Clear selection</button></div>
          <dl className="flight-facts"><div><dt>ICAO24</dt><dd>{selectedLabel}</dd></div><div><dt>Altitude</dt><dd>{selectedObservation?.altitudeFt == null ? "Unknown" : `${Math.round(selectedObservation.altitudeFt).toLocaleString()} ft ${selectedObservation.altitudeSource ?? ""}`}</dd></div><div><dt>Ground speed</dt><dd>{selectedObservation?.groundSpeedKt == null ? "Unknown" : `${Math.round(selectedObservation.groundSpeedKt)} kt`}</dd></div><div><dt>Track direction</dt><dd>{selectedObservation?.trackDeg == null ? "Unknown" : `${Math.round(selectedObservation.trackDeg)}°`}</dd></div></dl>
        </section>}

        {profile.isFetching ? <p className="track-empty" role="status">Building the selected aircraft's sourced profile...</p> : profile.error instanceof ProviderNotConfiguredError ? selectedIcao24 && <p className="track-empty">Aircraft profile gateway and FAA registry snapshot configuration are required. No profile facts are fabricated.</p> : profile.error instanceof AuthenticationRequiredError ? <p className="track-empty">Authenticated profile access is required.</p> : profile.isError ? <p className="track-error" role="alert">Aircraft profile unavailable: {profile.error.message}</p> : profile.data ? <AircraftProfilePanel profile={profile.data} /> : null}

        <section className="analytics-grid" id="analytics">
          {track.isFetching ? <p className="track-empty" role="status">Loading the selected aircraft's recorded observations...</p> : track.error instanceof ProviderNotConfiguredError ? null : track.isError ? <p className="track-error" role="alert">Track unavailable: {track.error.message}</p> : track.data?.points.length === 0 ? <p className="track-empty">No observations were recorded for this aircraft in the selected 24-hour window.</p> : track.data ? <ReplayPanel points={track.data.points} aircraftLabel={track.data.aircraft.registration ?? track.data.aircraft.icao24} index={replayIndex} onIndexChange={setReplayIndex} /> : null}
          {insights.isFetching ? <p className="track-empty" role="status">Computing track insights...</p> : insights.error instanceof ProviderNotConfiguredError ? null : insights.isError ? <p className="track-error" role="alert">Insights unavailable: {insights.error.message}</p> : insights.data ? (
            <section className="replay" aria-labelledby="insights-heading">
              <div className="replay-title"><div><p className="eyebrow">Track insights</p><h3 id="insights-heading">24-hour summary | {insights.data.aircraft.registration ?? insights.data.aircraft.icao24}</h3></div><span>{insights.data.summary.pointCount} points</span></div>
              <dl className="replay-facts">
                <div><dt>Sources</dt><dd>{insights.data.summary.sourceCount}</dd></div>
                <div><dt>Altitude range</dt><dd>{insights.data.summary.altitudeFt.min == null ? "Unknown" : `${Math.round(insights.data.summary.altitudeFt.min).toLocaleString()}-${Math.round(insights.data.summary.altitudeFt.max ?? insights.data.summary.altitudeFt.min).toLocaleString()} ft`}</dd></div>
                <div><dt>Average speed</dt><dd>{insights.data.summary.groundSpeedKt.average == null ? "Unknown" : `${Math.round(insights.data.summary.groundSpeedKt.average)} kt`}</dd></div>
              </dl>
            </section>
          ) : null}
          {routeSummary.isFetching ? <p className="track-empty" role="status">Computing route summary...</p> : routeSummary.error instanceof ProviderNotConfiguredError ? null : routeSummary.isError ? <p className="track-error" role="alert">Route summary unavailable: {routeSummary.error.message}</p> : routeSummary.data ? (
            <section className="replay" aria-labelledby="route-summary-heading">
              <div className="replay-title"><div><p className="eyebrow">Route analytics</p><h3 id="route-summary-heading">Path summary | {routeSummary.data.aircraft.registration ?? routeSummary.data.aircraft.icao24}</h3></div><span>{routeSummary.data.summary.loiteringDetected ? "Loitering" : "Transit"}</span></div>
              <dl className="replay-facts">
                <div><dt>Duration</dt><dd>{Math.round(routeSummary.data.summary.durationMinutes)} min</dd></div>
                <div><dt>Distance</dt><dd>{routeSummary.data.summary.totalDistanceNm.toFixed(1)} NM</dd></div>
                <div><dt>Loitering</dt><dd>{routeSummary.data.summary.loiteringDetected ? `${Math.round(routeSummary.data.summary.loiteringMinutes)} min` : "None"}</dd></div>
              </dl>
            </section>
          ) : null}
        </section>
        <section className="search-end section-panel" id="history-search-panel">          <form className="history-search" onSubmit={(event) => { event.preventDefault(); setSubmittedSearch(searchInput.trim()); setSelectedIcao24(null); goToSection("history-search-panel"); }}>
            <label htmlFor="history-search">Search recorded aircraft</label>
            <div><input id="history-search" value={searchInput} minLength={2} maxLength={24} pattern="[A-Za-z0-9\-]+" placeholder="Registration or ICAO24" onChange={(event) => setSearchInput(event.currentTarget.value)} /><button type="submit">Search history</button></div>
          </form>        {submittedSearch && (
          <section className="search-results section-panel" id="history-results" aria-live="polite">
            {search.error instanceof ProviderNotConfiguredError ? <p>History gateway configuration required. No recorded aircraft are fabricated.</p> : search.error instanceof AuthenticationRequiredError ? <p>Authenticated access is required before precise aircraft history can be searched.</p> : search.isError ? <p role="alert">{search.error.message}</p> : search.isFetching ? <p>Searching recorded observations...</p> : search.data?.aircraft.length === 0 ? <p>No matching aircraft have been recorded.</p> : <ul>{search.data?.aircraft.map((item) => <li key={item.id}><button type="button" aria-pressed={selectedIcao24 === item.icao24} onClick={() => { setSelectedIcao24(item.icao24); setReplayIndex(0); goToSection("analytics"); }}><strong>{item.registration ?? item.icao24}</strong><span>{item.icao24} | last observed UTC {new Date(item.lastSeenAt).toISOString()}</span></button></li>)}</ul>}
          </section>
        )}
</section>
        <details className="evidence-end"><summary>Add supporting evidence</summary><EvidenceUploadPanel /></details>
      </main>
      <footer><span>UTC-first | Provider-neutral | Evidence standard enforced</span><span>ADS-B observations · Flight data in UTC</span></footer>
    </div>
  );
}
