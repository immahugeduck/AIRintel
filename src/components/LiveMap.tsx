import { useEffect, useMemo, useState } from "react";
import { Marker, MapContainer, Polyline, TileLayer, Tooltip, ZoomControl, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import "./mapbox-settings.css";
import { divIcon, latLng, type LatLngExpression } from "leaflet";
import { segmentTracksByProvider, type TrackPoint, type AircraftObservation } from "../domain/aircraft";

type Props = { id?: string; center: LatLngExpression; observations?: AircraftObservation[]; selectedIcao24?: string | null; onSelectAircraft?: (icao24: string) => void; trackPoints?: TrackPoint[]; replayIndex?: number };

const NO_OBSERVATIONS: AircraftObservation[] = [];

function MapCenter({ center }: { center: LatLngExpression }) {
  const map = useMap();
  const { lat, lng } = latLng(center);
  useEffect(() => { map.setView([lat, lng], map.getZoom()); }, [map, lat, lng]);
  return null;
}

function aircraftIcon(trackDeg: number | null | undefined, selected: boolean) {
  const known = trackDeg != null;
  return divIcon({
    className: "aircraft-direction-marker",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `<div style="width:28px;height:28px;display:grid;place-items:center;color:${selected ? "#f0b85c" : "#37d4b5"};filter:drop-shadow(0 1px 2px #000);transform:rotate(${known ? trackDeg : 0}deg)"><svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">${known ? '<path d="M13 2 L23 23 L13 18 L3 23 Z" fill="currentColor" stroke="white" stroke-width="1.5"/>' : '<circle cx="13" cy="13" r="8" fill="currentColor" stroke="white" stroke-width="2"/>'}</svg></div>`,
  });
}

type StoredMapboxConfig = {
  accessToken: string;
  style: string;
};

const MAPBOX_STORAGE_KEY = "airintel.mapbox.config";
const DEFAULT_MAPBOX_STYLE = "mapbox/streets-v12";
const sourceColors = ["#37d4b5", "#f0b85c", "#79a8ff", "#e886b7"];

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
    if (typeof parsed.accessToken !== "string" || typeof parsed.style !== "string") return null;
    return { accessToken: parsed.accessToken, style: parsed.style };
  } catch {
    return null;
  }
};

const envConfig = (): StoredMapboxConfig | null => {
  const accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim();
  if (!accessToken) return null;
  const style = normalizeStyle(import.meta.env.VITE_MAPBOX_STYLE ?? DEFAULT_MAPBOX_STYLE) ?? DEFAULT_MAPBOX_STYLE;
  return { accessToken, style };
};

export function LiveMap({ id, center, observations = NO_OBSERVATIONS, selectedIcao24, onSelectAircraft, trackPoints = [], replayIndex = 0 }: Props) {
  const initialConfig = useMemo(() => loadStoredConfig() ?? envConfig(), []);
  const [mapboxConfig, setMapboxConfig] = useState<StoredMapboxConfig | null>(initialConfig);
  const [setupOpen, setSetupOpen] = useState(initialConfig === null);
  const [tokenInput, setTokenInput] = useState(initialConfig?.accessToken ?? "");
  const [styleInput, setStyleInput] = useState(initialConfig?.style ?? DEFAULT_MAPBOX_STYLE);
  const [setupError, setSetupError] = useState<string | null>(null);

  const [livePoints, setLivePoints] = useState<TrackPoint[]>([]);
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
    window.localStorage.setItem(MAPBOX_STORAGE_KEY, JSON.stringify(next));
    setMapboxConfig(next);
    setStyleInput(style);
    setSetupError(null);
    setSetupOpen(false);
  };

  const clearLocalMapboxConfig = () => {
    window.localStorage.removeItem(MAPBOX_STORAGE_KEY);
    const fallback = envConfig();
    setMapboxConfig(fallback);
    setTokenInput(fallback?.accessToken ?? "");
    setStyleInput(fallback?.style ?? DEFAULT_MAPBOX_STYLE);
    setSetupError(null);
    setSetupOpen(true);
  };

  return (
    <section id={id} className="map-panel" aria-labelledby="map-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Observed positions</p>
          <h2 id="map-heading">Live map</h2>
        </div>
        <div className="map-heading-actions">
          <span className={`status-chip ${configured ? "ready" : "blocked"}`}>
            {configured ? "Mapbox ready" : "Mapbox configuration required"}
          </span>
          <button type="button" className="ghost-button" onClick={() => setSetupOpen(true)}>Map settings</button>
        </div>
      </div>
      <p>Live trails show observations collected during the last 10 minutes on this page. Select an aircraft to load recorded history. Arrows show observed track direction; circles indicate unknown direction.</p>
      <div className="map-frame">
        <MapContainer center={center} zoom={9} zoomControl={false} className="map" aria-label="Aircraft map">
          <MapCenter center={center} />
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
          {liveTracks.map(({ key, tracks }) => tracks.map((track) => track.segments
            .filter((segment) => segment.kind === "observed" && segment.points.length > 1)
            .map((segment, index) => <Polyline key={`live:${key}:${index}`} positions={segment.points.map((point) => [point.latitude, point.longitude] as LatLngExpression)} pathOptions={{ color: "#37d4b5", weight: 2, opacity: 0.6 }} />)))}
          {observations.map((point) => <Marker
            key={`live:${point.provider}:${point.icao24}`}
            position={[point.latitude, point.longitude]}
            icon={aircraftIcon(point.trackDeg, point.icao24 === selectedIcao24)}
            eventHandlers={{ click: () => onSelectAircraft?.(point.icao24) }}
          ><Tooltip direction="top">
            <strong>{point.registration ?? point.callsign ?? point.icao24}</strong><br />
            {point.provider} | Observed {new Date(point.observedAt).toISOString()}<br />
            Track direction: {point.trackDeg == null ? "Unknown" : `${point.trackDeg.toFixed(0)}°`}<br />
            Ground speed: {point.groundSpeedKt == null ? "Unknown" : `${point.groundSpeedKt.toFixed(0)} kt`}
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
        {!configured && (
          <div className="map-blocker" role="status">
            <span className="radar-mark" aria-hidden="true" />
            <strong>Mapbox setup required</strong>
            <p>Add a browser-safe Mapbox public token to display the basemap. Aircraft data and route analysis remain separate from the basemap provider.</p>
            <button type="button" className="ghost-button" onClick={() => setSetupOpen(true)}>Configure Mapbox</button>
          </div>
        )}
      </div>

      {setupOpen && (
        <div className="mapbox-dialog-backdrop" role="presentation">
          <section className="mapbox-dialog" role="dialog" aria-modal="true" aria-labelledby="mapbox-dialog-title">
            <div className="mapbox-dialog-heading">
              <div>
                <p className="eyebrow">Basemap configuration</p>
                <h3 id="mapbox-dialog-title">Connect Mapbox</h3>
              </div>
              {configured && <button type="button" className="dialog-close" aria-label="Close Mapbox settings" onClick={() => setSetupOpen(false)}>×</button>}
            </div>
            <p className="mapbox-dialog-copy">Enter a public Mapbox access token and a published style. This browser setup is stored only on this device. For deployment, configure the same values as environment variables.</p>
            <label>
              Public access token
              <input type="password" autoComplete="off" spellCheck={false} value={tokenInput} placeholder="pk.eyJ..." onChange={(event) => setTokenInput(event.currentTarget.value)} />
            </label>
            <label>
              Mapbox style
              <input type="text" autoComplete="off" spellCheck={false} value={styleInput} placeholder="mapbox/streets-v12" onChange={(event) => setStyleInput(event.currentTarget.value)} />
              <small>Accepted: username/style-id or mapbox://styles/username/style-id. Static Leaflet tiles do not currently support Mapbox Standard.</small>
            </label>
            {setupError && <p className="mapbox-dialog-error" role="alert">{setupError}</p>}
            <div className="mapbox-dialog-actions">
              {configured && <button type="button" className="ghost-button" onClick={clearLocalMapboxConfig}>Reset local config</button>}
              <button type="button" className="mapbox-save-button" onClick={saveMapboxConfig}>Save Mapbox settings</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
