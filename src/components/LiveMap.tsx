import { useMemo, useState } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, ZoomControl } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import "./mapbox-settings.css";
import type { LatLngExpression } from "leaflet";
import { segmentTracksByProvider, type TrackPoint } from "../domain/aircraft";

type Props = { id?: string; center: LatLngExpression; trackPoints?: TrackPoint[]; replayIndex?: number };

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

export function LiveMap({ id, center, trackPoints = [], replayIndex = 0 }: Props) {
  const initialConfig = useMemo(() => loadStoredConfig() ?? envConfig(), []);
  const [mapboxConfig, setMapboxConfig] = useState<StoredMapboxConfig | null>(initialConfig);
  const [setupOpen, setSetupOpen] = useState(initialConfig === null);
  const [tokenInput, setTokenInput] = useState(initialConfig?.accessToken ?? "");
  const [styleInput, setStyleInput] = useState(initialConfig?.style ?? DEFAULT_MAPBOX_STYLE);
  const [setupError, setSetupError] = useState<string | null>(null);

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
      <div className="map-frame">
        <MapContainer center={center} zoom={9} zoomControl={false} className="map" aria-label="Aircraft map">
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
          {providerTracks.map((track, sourceIndex) => track.segments.map((segment, segmentIndex) => (
            <Polyline
              key={`${track.provider}:${segment.kind}:${segmentIndex}`}
              positions={segment.points.map((point) => [point.latitude, point.longitude] as LatLngExpression)}
              pathOptions={{ color: sourceColors[sourceIndex % sourceColors.length], weight: segment.kind === "gap" ? 2 : 3, dashArray: segment.kind === "gap" ? "5 9" : undefined, opacity: segment.kind === "gap" ? 0.55 : 0.9 }}
            />
          )))}
          {replayPoint && <CircleMarker center={[replayPoint.latitude, replayPoint.longitude]} radius={8} pathOptions={{ color: "#ffffff", fillColor: "#37d4b5", fillOpacity: 1, weight: 3 }}><Tooltip permanent direction="top">{replayPoint.registration ?? replayPoint.callsign ?? replayPoint.icao24}</Tooltip></CircleMarker>}
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
