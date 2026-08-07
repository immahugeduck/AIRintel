import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { fetchAircraft } from "./api/aircraft";
import { fetchRecentTrack, searchAircraft } from "./api/history";
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

  const sourceState = aircraft.error instanceof ProviderNotConfiguredError ? "Configuration required" : aircraft.isError ? "Feed unavailable" : aircraft.isFetching ? "Refreshing" : "Connected";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">AI</div>
        <div className="brand-copy"><strong>AIRIntel</strong><span>AirRoute Intelligence</span></div>
        <div className="system-state"><span className="pulse" />{sourceState}</div>
      </header>
      <main id="main">
        <section className="hero">
          <div><p className="eyebrow">Phase 2 · Flight Recorder</p><h1>Live airspace, with every claim sourced.</h1><p>Provider-neutral aircraft intelligence that preserves provenance, freshness, uncertainty, and gaps.</p></div>
          <div className="evidence-key" aria-label="Evidence vocabulary"><span>Observed</span><span>Calculated</span><span>Supported inference</span><span>Unknown</span></div>
        </section>
        <section className="query-bar" aria-label="Aircraft search area">
          <label>Latitude<input type="number" value={latitude} min={-90} max={90} step="0.0001" onChange={(e) => setLatitude(e.currentTarget.valueAsNumber)} /></label>
          <label>Longitude<input type="number" value={longitude} min={-180} max={180} step="0.0001" onChange={(e) => setLongitude(e.currentTarget.valueAsNumber)} /></label>
          <label>Radius (NM)<input type="number" value={radiusNm} min={1} max={100} onChange={(e) => setRadiusNm(e.currentTarget.valueAsNumber)} /></label>
          <button type="button" onClick={() => void aircraft.refetch()} disabled={aircraft.isFetching}>Refresh observations</button>
        </section>
        <form className="history-search" onSubmit={(event) => { event.preventDefault(); setSubmittedSearch(searchInput.trim()); setSelectedIcao24(null); }}>
          <label htmlFor="history-search">Search recorded aircraft</label>
          <div><input id="history-search" value={searchInput} minLength={2} maxLength={24} pattern="[A-Za-z0-9-]+" placeholder="Registration or ICAO24" onChange={(event) => setSearchInput(event.currentTarget.value)} /><button type="submit">Search history</button></div>
        </form>
        {submittedSearch && (
          <section className="search-results" aria-live="polite">
            {search.error instanceof ProviderNotConfiguredError ? <p>History gateway configuration required. No recorded aircraft are fabricated.</p> : search.error instanceof AuthenticationRequiredError ? <p>Authenticated access is required before precise aircraft history can be searched.</p> : search.isError ? <p role="alert">{search.error.message}</p> : search.isFetching ? <p>Searching recorded observations…</p> : search.data?.aircraft.length === 0 ? <p>No matching aircraft have been recorded.</p> : <ul>{search.data?.aircraft.map((item) => <li key={item.id}><button type="button" aria-pressed={selectedIcao24 === item.icao24} onClick={() => { setSelectedIcao24(item.icao24); setReplayIndex(0); }}><strong>{item.registration ?? item.icao24}</strong><span>{item.icao24} · last observed UTC {new Date(item.lastSeenAt).toISOString()}</span></button></li>)}</ul>}
          </section>
        )}
        <div className="workspace-grid">
          <LiveMap center={[latitude, longitude]} trackPoints={track.data?.points ?? []} replayIndex={replayIndex} />
          <aside className="intel-panel" aria-labelledby="intel-heading">
            <div className="panel-heading"><div><p className="eyebrow">Data health</p><h2 id="intel-heading">Aircraft observations</h2></div><span className="count">{aircraft.data?.observations.length ?? 0}</span></div>
            {aircraft.error instanceof ProviderNotConfiguredError ? (
              <div className="empty-state"><div className="empty-icon" aria-hidden="true">⌁</div><h3>Live provider not configured</h3><p>No aircraft are displayed because AIRIntel will not fabricate observations. Add a documented server-side provider gateway to begin.</p><code>VITE_AIRCRAFT_API_URL</code></div>
            ) : aircraft.isError ? (
              <div className="empty-state error" role="alert"><h3>Aircraft feed unavailable</h3><p>{aircraft.error.message}</p></div>
            ) : aircraft.data?.observations.length === 0 ? (
              <div className="empty-state"><h3>No observations received</h3><p>The configured source returned no aircraft for this area and refresh window. This does not establish that the airspace is empty.</p></div>
            ) : (
              <ul className="aircraft-list">{aircraft.data?.observations.map((item) => <li key={`${item.provider}:${item.icao24}:${item.observedAt}`}><strong>{item.registration ?? item.callsign ?? item.icao24}</strong><span>{item.altitudeFt == null ? "Altitude unknown" : `${Math.round(item.altitudeFt).toLocaleString()} ft ${item.altitudeSource}`}</span><small>{item.provider} · observed {new Date(item.observedAt).toLocaleTimeString()}</small></li>)}</ul>
            )}
          </aside>
        </div>
        {track.isFetching ? <p className="track-empty" role="status">Loading the selected aircraft’s recorded observations…</p> : track.error instanceof ProviderNotConfiguredError ? null : track.isError ? <p className="track-error" role="alert">Track unavailable: {track.error.message}</p> : track.data?.points.length === 0 ? <p className="track-empty">No observations were recorded for this aircraft in the selected 24-hour window.</p> : track.data ? <ReplayPanel points={track.data.points} aircraftLabel={track.data.aircraft.registration ?? track.data.aircraft.icao24} index={replayIndex} onIndexChange={setReplayIndex} /> : null}
      </main>
      <footer><span>UTC-first · Provider-neutral · Evidence standard enforced</span><span>Phase 2 · Configuration gated</span></footer>
    </div>
  );
}
