import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { fetchAircraft } from "./api/aircraft";
import { LiveMap } from "./components/LiveMap";
import { ProviderNotConfiguredError } from "./providers/contracts";

const envNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export default function App() {
  const [latitude, setLatitude] = useState(envNumber(import.meta.env.VITE_DEFAULT_CENTER_LAT, 39.7684));
  const [longitude, setLongitude] = useState(envNumber(import.meta.env.VITE_DEFAULT_CENTER_LON, -86.1581));
  const [radiusNm, setRadiusNm] = useState(envNumber(import.meta.env.VITE_DEFAULT_RADIUS_NM, 20));
  const query = useMemo(() => ({ latitude, longitude, radiusNm }), [latitude, longitude, radiusNm]);
  const pollMs = envNumber(import.meta.env.VITE_POLL_INTERVAL_SECONDS, 20) * 1000;
  const aircraft = useQuery({
    queryKey: ["aircraft", query],
    queryFn: ({ signal }) => fetchAircraft(query, signal),
    refetchInterval: import.meta.env.VITE_AIRCRAFT_API_URL ? pollMs : false,
    retry: (count, error) => !(error instanceof ProviderNotConfiguredError) && count < 2,
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
          <div><p className="eyebrow">Phase 1 · Foundation</p><h1>Live airspace, with every claim sourced.</h1><p>Provider-neutral aircraft intelligence that preserves provenance, freshness, uncertainty, and gaps.</p></div>
          <div className="evidence-key" aria-label="Evidence vocabulary"><span>Observed</span><span>Calculated</span><span>Supported inference</span><span>Unknown</span></div>
        </section>
        <section className="query-bar" aria-label="Aircraft search area">
          <label>Latitude<input type="number" value={latitude} min={-90} max={90} step="0.0001" onChange={(e) => setLatitude(e.currentTarget.valueAsNumber)} /></label>
          <label>Longitude<input type="number" value={longitude} min={-180} max={180} step="0.0001" onChange={(e) => setLongitude(e.currentTarget.valueAsNumber)} /></label>
          <label>Radius (NM)<input type="number" value={radiusNm} min={1} max={100} onChange={(e) => setRadiusNm(e.currentTarget.valueAsNumber)} /></label>
          <button type="button" onClick={() => void aircraft.refetch()} disabled={aircraft.isFetching}>Refresh observations</button>
        </section>
        <div className="workspace-grid">
          <LiveMap center={[latitude, longitude]} />
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
      </main>
      <footer><span>UTC-first · Provider-neutral · Evidence standard enforced</span><span>Phase 1A</span></footer>
    </div>
  );
}
