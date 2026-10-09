import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Circle, CircleMarker, Marker, MapContainer, Polyline, TileLayer, Tooltip, ZoomControl, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import "./mapbox-settings.css";
import { divIcon, latLng, type LatLngExpression } from "leaflet";
import { watchAreaBounds } from "../domain/geometry";
import { segmentTracksByProvider, type TrackPoint, type AircraftObservation } from "../domain/aircraft";
import { WATCH_RADIUS_MI, formatAltitudeFt, formatLastSeen, formatSpeedMph, milesToMeters, milesToNm } from "../domain/units";

type Props = { id?: string; settingsOpen?: boolean; onSettingsOpenChange?: (open: boolean) => void; center: LatLngExpression; radiusMi?: number; observations?: AircraftObservation[]; selectedIcao24?: string | null; onSelectAircraft?: (icao24: string) => void; trackPoints?: TrackPoint[]; replayIndex?: number };

/** Map colors mirror the CSS tokens in styles.css (--sky / --amber / --signal). */
const MAP_COLORS = { aircraft: "#8cc4f2", selected: "#f2b544", radius: "#f2b544", trail: "#8cc4f2", me: "#7fd6a4" } as const;

/** Leaflet only listens to window resizes; panels and tab switches resize the map container too. */
function MapResizer() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);
  return null;
}

const NO_OBSERVATIONS: AircraftObservation[] = [];
const NO_TRACK_POINTS: TrackPoint[] = [];

function MapCenter({ center, radiusNm }: { center: LatLngExpression; radiusNm: number }) {
  const map = useMap();
  const { lat, lng } = latLng(center);
  useEffect(() => { map.fitBounds(watchAreaBounds(lat, lng, radiusNm), { padding: [16, 16] }); }, [map, lat, lng, radiusNm]);
  return null;
}

function aircraftIcon(trackDeg: number | null | undefined, selected: boolean) {
  const known = trackDeg != null;
  return divIcon({
    className: "aircraft-direction-marker",
    // 44px hit area for touch; the glyph itself stays 26px.
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    html: `<div style="width:44px;height:44px;display:grid;place-items:center;color:${selected ? MAP_COLORS.selected : MAP_COLORS.aircraft};filter:drop-shadow(0 1px 2px rgba(0,0,0,.8));transform:rotate(${known ? trackDeg : 0}deg)"><svg width="${selected ? 30 : 26}" height="${selected ? 30 : 26}" viewBox="0 0 26 26" aria-hidden="true">${known ? '<path d="M12 2 L14 2 L15 10 L24 16 L24 18 L15 15 L15 21 L19 24 L19 25 L13 23 L7 25 L7 24 L11 21 L11 15 L2 18 L2 16 L11 10 Z" fill="currentColor" stroke="#0b1117" stroke-width="1.2"/>' : '<circle cx="13" cy="13" r="8" fill="currentColor" stroke="#0b1117" stroke-width="2"/>'}</svg></div>`,
  });
}

type StoredMapboxConfig = {
  accessToken: string;
  style: string;
};

const MAPBOX_STORAGE_KEY = "airintel.mapbox.config";
const DEFAULT_MAPBOX_STYLE = "mapbox/streets-v12";
const sourceColors = ["#8cc4f2", "#f2b544", "#7fd6a4", "#e3a0c8"];

const normalizeStyle = (input: string) => {
  const normalized = input.trim().replace(/^mapbox:\/\/styles\//i, "").replace(/^https:\/\/api\.mapbox\.com\/styles\/v1\//i, "");
  const [username, styleId] = normalized.split(/[/?#]/).filter(Boolean);
  return username && styleId ? `${username}/${styleId}` : null;
};

const loadStoredConfig = (): StoredMapboxConfig | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MAPBOX_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredMapboxConfig>;
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken.trim().startsWith("pk.") || typeof parsed.style !== "string") return null;
    const style = normalizeStyle(parsed.style);
    return style ? { accessToken: parsed.accessToken.trim(), style } : null;
  } catch {
    return null;
  }
};

const envConfig = (): StoredMapboxConfig | null => {
  const accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim();
  if (!accessToken?.startsWith("pk.")) return null;
  const style = normalizeStyle(import.meta.env.VITE_MAPBOX_STYLE ?? DEFAULT_MAPBOX_STYLE) ?? DEFAULT_MAPBOX_STYLE;
  return { accessToken, style };
};

export function LiveMap({ id, settingsOpen, onSettingsOpenChange, center, radiusMi = WATCH_RADIUS_MI, observations = NO_OBSERVATIONS, selectedIcao24, onSelectAircraft, trackPoints = NO_TRACK_POINTS, replayIndex = 0 }: Props) {
  const initialConfig = useMemo(() => loadStoredConfig() ?? envConfig(), []);
  const [mapboxConfig, setMapboxConfig] = useState<StoredMapboxConfig | null>(initialConfig);
  const radiusNm = milesToNm(radiusMi);
  // Never open a modal on first load (it blocked phones); the map shows a setup prompt instead.
  const [localSetupOpen, setLocalSetupOpen] = useState(false);
  const setupOpen = settingsOpen ?? localSetupOpen;
  const setSetupOpen = (open: boolean) => { setLocalSetupOpen(open); onSettingsOpenChange?.(open); };
  const [tokenInput, setTokenInput] = useState(initialConfig?.accessToken ?? "");
  const [styleInput, setStyleInput] = useState(initialConfig?.style ?? DEFAULT_MAPBOX_STYLE);
  const [showTrails, setShowTrails] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const [livePoints, setLivePoints] = useState<TrackPoint[]>([]);
  const { lat: centerLat, lng: centerLng } = latLng(center);
  useEffect(() => { setLivePoints([]); }, [centerLat, centerLng, radiusNm]);
  useEffect(() => {
    setLivePoints((previous) => {
      const cutoff = Date.now() - 10 * 60_000;
      const points = new Map<string, TrackPoint>();
      for (const point of [...previous, ...observations]) {
        if (Date.parse(point.observedAt) >= cutoff) {
          points.set(`${point.provider}:${point.icao24}:${point.observedAt}`, point);
        }
      }
      return [...points.values()].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).slice(-5000);
    });
  }, [observations]);
  const liveTracks = useMemo(() => {
    const grouped = new Map<string, TrackPoint[]>();
    for (const point of livePoints) {
      const key = `${point.provider}:${point.icao24}`;
      const group = grouped.get(key) ?? [];
      group.push(point);
      grouped.set(key, group);
    }
    return [...grouped.entries()].map(([key, points]) => ({ key, tracks: segmentTracksByProvider(points) }));
  }, [livePoints]);
  const providerTracks = segmentTracksByProvider(trackPoints);
  const ordered = [...trackPoints].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const replayPoint = ordered[Math.min(replayIndex, Math.max(0, ordered.length - 1))];
  const configured = mapboxConfig !== null;
  const tileUrl = configured
    ? `https://api.mapbox.com/styles/v1/${mapboxConfig.style}/tiles/512/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(mapboxConfig.accessToken)}`
    : null;

  useEffect(() => {
    if (!setupOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setLocalSetupOpen(false); onSettingsOpenChange?.(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setupOpen, onSettingsOpenChange]);

  const saveMapboxConfig = () => {
    const token = tokenInput.trim();
    const style = normalizeStyle(styleInput);

    if (!token.startsWith("pk.")) {
      setSetupError("Use a Mapbox public access token beginning with pk. Secret tokens must never be stored in the browser.");
      return;
    }
    if (!style) {
      setSetupError("Enter a style as username/style-id or a mapbox://styles/username/style-id URL.");
      return;
    }

    const next = { accessToken: token, style };
    try { window.localStorage.setItem(MAPBOX_STORAGE_KEY, JSON.stringify(next)); } catch { /* Private browsing can block storage; still use this session configuration. */ }
    setMapboxConfig(next);
    setStyleInput(style);
    setSetupError(null);
    setSetupOpen(false);
  };

  const clearLocalMapboxConfig = () => {
    try { window.localStorage.removeItem(MAPBOX_STORAGE_KEY); } catch { /* Storage is optional. */ }
    const fallback = envConfig();
    setMapboxConfig(fallback);
    setTokenInput(fallback?.accessToken ?? "");
    setStyleInput(fallback?.style ?? DEFAULT_MAPBOX_STYLE);
    setSetupError(null);
    setSetupOpen(true);
  };

  return (
    <section id={id} className="map-panel" aria-labelledby="map-heading">
      <div className="map-toolbar">
        <h2 id="map-heading" className="sr-only">Live map</h2>
        <span className={`status-pill ${configured ? "is-ok" : "is-warn"}`}>{configured ? "Basemap on" : "Basemap needed"}</span>
        <div className="map-heading-actions">
          <button type="button" className="chip-toggle" aria-pressed={showTrails} onClick={() => setShowTrails(!showTrails)}>Trails</button>
          <button type="button" className="chip-toggle" aria-pressed={showLabels} onClick={() => setShowLabels(!showLabels)}>Labels</button>
          <button type="button" className="chip-toggle" onClick={() => setSetupOpen(true)}>Map settings</button>
        </div>
      </div>
      <div className="map-frame">
        <MapContainer center={center} zoom={10} zoomControl={false} className="map" aria-label="Aircraft map" tapTolerance={20}>
          <MapResizer />
          <MapCenter center={center} radiusNm={radiusNm} />
          <Circle center={center} radius={milesToMeters(radiusMi)} pathOptions={{ color: MAP_COLORS.radius, weight: 1.5, dashArray: "6 6", fillOpacity: 0.05 }} interactive={false} />
          <CircleMarker center={center} radius={7} pathOptions={{ color: "#0b1117", weight: 2, fillColor: MAP_COLORS.me, fillOpacity: 1 }}><Tooltip direction="bottom">My location · {radiusMi} mi radius</Tooltip></CircleMarker>
          <ZoomControl position="bottomright" />
          {tileUrl ? (
            <TileLayer
              url={tileUrl}
              tileSize={512}
              zoomOffset={-1}
              maxZoom={22}
              attribution='&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            />
          ) : null}
          {showTrails && liveTracks.map(({ key, tracks }) => tracks.map((track) => track.segments
            .filter((segment) => segment.kind === "observed" && segment.points.length > 1)
            .map((segment, index) => <Polyline key={`live:${key}:${index}`} positions={segment.points.map((point) => [point.latitude, point.longitude] as LatLngExpression)} pathOptions={{ color: MAP_COLORS.trail, weight: 2, opacity: 0.55 }} />)))}
          {observations.map((point) => <Marker
            key={`live:${point.provider}:${point.icao24}`}
            position={[point.latitude, point.longitude]}
            icon={aircraftIcon(point.trackDeg, point.icao24 === selectedIcao24)}
            eventHandlers={{ click: () => onSelectAircraft?.(point.icao24) }}
          ><Tooltip direction="top" permanent={showLabels || point.icao24 === selectedIcao24}>
            <strong>{point.callsign ?? point.registration ?? point.icao24.toUpperCase()}</strong><br />
            {formatAltitudeFt(point.altitudeFt, point.onGround)} · {formatSpeedMph(point.groundSpeedKt)}<br />
            Seen {formatLastSeen(point.observedAt)} · {point.provider}
          </Tooltip></Marker>)}
          {providerTracks.map((track, sourceIndex) => track.segments.map((segment, segmentIndex) => (
            <Polyline
              key={`${track.provider}:${segment.kind}:${segmentIndex}`}
              positions={segment.points.map((point) => [point.latitude, point.longitude] as LatLngExpression)}
              pathOptions={{ color: sourceColors[sourceIndex % sourceColors.length], weight: segment.kind === "gap" ? 2 : 3, dashArray: segment.kind === "gap" ? "5 9" : undefined, opacity: segment.kind === "gap" ? 0.55 : 0.9 }}
            />
          )))}
          {replayPoint && <Marker position={[replayPoint.latitude, replayPoint.longitude]} icon={aircraftIcon(replayPoint.trackDeg, true)}><Tooltip permanent direction="top">{replayPoint.registration ?? replayPoint.callsign ?? replayPoint.icao24}</Tooltip></Marker>}
        </MapContainer>
        <p className="map-legend" aria-label="Map legend"><span><i className="dot dot-aircraft" />Aircraft</span><span><i className="dot dot-selected" />Selected</span><span><i className="dot dot-me" />Me</span></p>
        {!configured && (
          <div className="map-blocker" role="status">
            <span className="radar-mark" aria-hidden="true" />
            <strong>Basemap not connected</strong>
            <p>Aircraft still plot on the grid. Add a public Mapbox token (pk.…) to show streets and terrain.</p>
            <button type="button" className="button button-ghost" onClick={() => setSetupOpen(true)}>Connect Mapbox</button>
          </div>
        )}
      </div>

      {setupOpen && createPortal(
        <div className="mapbox-dialog-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setSetupOpen(false); }}>
          <section className="mapbox-dialog" role="dialog" aria-modal="true" aria-labelledby="mapbox-dialog-title">
            <div className="mapbox-dialog-heading">
              <div>
                <p className="eyebrow">Basemap configuration</p>
                <h3 id="mapbox-dialog-title">Connect Mapbox</h3>
              </div>
              <button type="button" className="icon-button" aria-label="Close Mapbox settings" onClick={() => setSetupOpen(false)}>×</button>
            </div>
            <p className="mapbox-dialog-copy">Enter a public Mapbox access token and a published style. This browser setup is stored only on this device. For deployment, configure the same values as environment variables.</p>
            <label>
              Public access token
              <input type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={tokenInput} placeholder="pk.eyJ..." onChange={(event) => setTokenInput(event.currentTarget.value)} />
            </label>
            <label>
              Mapbox style
              <input type="text" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={styleInput} placeholder="mapbox/streets-v12" onChange={(event) => setStyleInput(event.currentTarget.value)} />
              <small>Accepted: username/style-id or mapbox://styles/username/style-id. Static Leaflet tiles do not currently support Mapbox Standard.</small>
            </label>
            {setupError && <p className="mapbox-dialog-error" role="alert">{setupError}</p>}
            <div className="mapbox-dialog-actions">
              {configured && <button type="button" className="button button-ghost" onClick={clearLocalMapboxConfig}>Reset local config</button>}
              <button type="button" className="button button-primary" onClick={saveMapboxConfig}>Save Mapbox settings</button>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </section>
  );
}
