import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { fetchAircraft } from "./api/aircraft";
import { fetchNearbyAircraft, fetchRecentTrack, fetchRouteSummary, fetchTrackInsights, searchAircraft } from "./api/history";
import { fetchAircraftProfile } from "./api/profile";
import { AircraftProfilePanel } from "./components/AircraftProfilePanel";
import { LiveMap } from "./components/LiveMap";
import { ReplayPanel } from "./components/ReplayPanel";
import { AuthenticationRequiredError, ProviderNotConfiguredError } from "./providers/contracts";

const envNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export default function App() {
  const [latitude, setLatitude] = useState(envNumber(import.meta.env.VITE_DEFAULT_CENTER_LAT, 39.7684));
  const [longitude, setLongitude] = useState(envNumber(import.meta.env.VITE_DEFAULT_CENTER_LON, -86.1581));
  const [radiusNm, setRadiusNm] = useState(envNumber(import.meta.env.VITE_DEFAULT_RADIUS_NM, 20));
  const [searchInput, setSearchInput] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [selectedIcao24, setSelectedIcao24] = useState<string | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [activeSection, setActiveSection] = useState("overview");
  const query = useMemo(() => ({ latitude, longitude, radiusNm }), [latitude, longitude, radiusNm]);
  const pollMs = envNumber(import.meta.env.VITE_POLL_INTERVAL_SECONDS, 20) * 1000;
  const aircraft = useQuery({
    queryKey: ["aircraft", query],
    queryFn: ({ signal }) => fetchAircraft(query, signal),
    refetchInterval: import.meta.env.VITE_AIRCRAFT_API_URL ? pollMs : false,
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
    enabled: Boolean(import.meta.env.VITE_HISTORY_API_URL),
    retry: false,
  });

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
            <option value="overview">Overview</option>
            <option value="live-feed">Live feed</option>
            <option value="history-results">History</option>
            <option value="analytics">Analytics</option>
          </select>
        </label>
        <div className="system-state"><span className="pulse" />{sourceState}</div>
      </header>
      <main id="main">
        <section className="hero" id="overview">
          <div className="hero-copy">
            <p className="eyebrow">Phase 3 | Aircraft Intelligence</p>
            <h1>Aircraft identity, with every claim sourced.</h1>
            <p>Observed identifiers, dated FAA registry facts, and deterministic activity statistics without turning ownership into assumptions about operation.</p>
          </div>
          <div className="hero-meta">
            <div className="hero-card">
              <span>Selected aircraft</span>
              <strong>{selectedLabel}</strong>
              <small>{selectedIcao24 ? "History and analytics are active" : "Choose a recorded aircraft to unlock replay"}</small>
            </div>
            <div className="evidence-key" aria-label="Evidence vocabulary"><span>Observed</span><span>Calculated</span><span>Supported inference</span><span>Unknown</span></div>
          </div>
        </section>
        <section className="dashboard-grid" aria-label="Live aircraft controls and search">
          <div className="query-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Spatial query</p>
                <h2>Live area</h2>
              </div>
              <button type="button" className="ghost-button" onClick={() => void aircraft.refetch()} disabled={aircraft.isFetching}>Refresh</button>
            </div>
            <div className="query-bar">
              <label>Latitude<input type="number" value={latitude} min={-90} max={90} step="0.0001" onChange={(e) => setLatitude(e.currentTarget.valueAsNumber)} /></label>
              <label>Longitude<input type="number" value={longitude} min={-180} max={180} step="0.0001" onChange={(e) => setLongitude(e.currentTarget.valueAsNumber)} /></label>
              <label>Radius (NM)<input type="number" value={radiusNm} min={1} max={100} onChange={(e) => setRadiusNm(e.currentTarget.valueAsNumber)} /></label>
            </div>
            <div className="stat-strip">
              <div><span>Live observations</span><strong>{aircraft.data?.observations.length ?? 0}</strong></div>
              <div><span>History matches</span><strong>{search.data?.aircraft.length ?? 0}</strong></div>
              <div><span>Nearby matches</span><strong>{nearby.data?.matches.length ?? 0}</strong></div>
            </div>
          </div>
          <form className="history-search" onSubmit={(event) => { event.preventDefault(); setSubmittedSearch(searchInput.trim()); setSelectedIcao24(null); goToSection("history-results"); }}>
            <label htmlFor="history-search">Search recorded aircraft</label>
            <div><input id="history-search" value={searchInput} minLength={2} maxLength={24} pattern="[A-Za-z0-9-]+" placeholder="Registration or ICAO24" onChange={(event) => setSearchInput(event.currentTarget.value)} /><button type="submit">Search history</button></div>
          </form>
        </section>
        {submittedSearch && (
          <section className="search-results section-panel" id="history-results" aria-live="polite">
            {search.error instanceof ProviderNotConfiguredError ? <p>History gateway configuration required. No recorded aircraft are fabricated.</p> : search.error instanceof AuthenticationRequiredError ? <p>Authenticated access is required before precise aircraft history can be searched.</p> : search.isError ? <p role="alert">{search.error.message}</p> : search.isFetching ? <p>Searching recorded observations...</p> : search.data?.aircraft.length === 0 ? <p>No matching aircraft have been recorded.</p> : <ul>{search.data?.aircraft.map((item) => <li key={item.id}><button type="button" aria-pressed={selectedIcao24 === item.icao24} onClick={() => { setSelectedIcao24(item.icao24); setReplayIndex(0); goToSection("analytics"); }}><strong>{item.registration ?? item.icao24}</strong><span>{item.icao24} | last observed UTC {new Date(item.lastSeenAt).toISOString()}</span></button></li>)}</ul>}
          </section>
        )}
        <div className="workspace-grid">
          <LiveMap id="live-feed" center={[latitude, longitude]} trackPoints={track.data?.points ?? []} replayIndex={replayIndex} />
          <aside className="intel-panel section-panel" aria-labelledby="intel-heading">
            <div className="panel-heading"><div><p className="eyebrow">Data health</p><h2 id="intel-heading">Aircraft observations</h2></div><span className="count">{aircraft.data?.observations.length ?? 0}</span></div>
            {aircraft.error instanceof ProviderNotConfiguredError ? (
              <div className="empty-state"><div className="empty-icon" aria-hidden="true">AIR</div><h3>Live provider not configured</h3><p>No aircraft are displayed because AIRIntel will not fabricate observations. Add a documented server-side provider gateway to begin.</p><code>VITE_AIRCRAFT_API_URL</code></div>
            ) : aircraft.isError ? (
              <div className="empty-state error" role="alert"><h3>Aircraft feed unavailable</h3><p>{aircraft.error.message}</p></div>
            ) : aircraft.data?.observations.length === 0 ? (
              <div className="empty-state"><h3>No observations received</h3><p>The configured source returned no aircraft for this area and refresh window. This does not establish that the airspace is empty.</p></div>
            ) : (
              <ul className="aircraft-list">{aircraft.data?.observations.map((item) => <li key={`${item.provider}:${item.icao24}:${item.observedAt}`}><strong>{item.registration ?? item.callsign ?? item.icao24}</strong><span>{item.altitudeFt == null ? "Altitude unknown" : `${Math.round(item.altitudeFt).toLocaleString()} ft ${item.altitudeSource}`}</span><small>{item.provider} | observed {new Date(item.observedAt).toLocaleTimeString()}</small></li>)}</ul>
            )}
          </aside>
        </div>
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
          {nearby.isFetching ? <p className="track-empty" role="status">Scanning nearby aircraft...</p> : nearby.error instanceof ProviderNotConfiguredError ? null : nearby.isError ? <p className="track-error" role="alert">Nearby aircraft unavailable: {nearby.error.message}</p> : nearby.data && nearby.data.matches.length > 0 ? (
            <section className="replay" aria-labelledby="nearby-heading">
              <div className="replay-title"><div><p className="eyebrow">Proximity</p><h3 id="nearby-heading">Nearby aircraft within {nearby.data.query.radiusNm.toFixed(0)} NM</h3></div><span>{nearby.data.matches.length} matches</span></div>
              <ul className="aircraft-list">{nearby.data.matches.map((item) => <li key={item.icao24}><strong>{item.registration ?? item.callsign ?? item.icao24}</strong><span>{item.distanceNm.toFixed(1)} NM away</span><small>{item.icao24} | {new Date(item.observedAt).toISOString()}</small></li>)}</ul>
            </section>
          ) : null}
        </section>
      </main>
      <footer><span>UTC-first | Provider-neutral | Evidence standard enforced</span><span>Phase 3 | Configuration gated</span></footer>
    </div>
  );
}
