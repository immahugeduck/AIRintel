import { useEffect, useId, useState, type FormEvent } from "react";
import { MAX_WATCH_RADIUS_MI, MIN_WATCH_RADIUS_MI } from "../domain/units";
import { clampRadiusMi, geolocationErrorMessage, type WatchArea } from "../lib/watch-area";

type Props = { area: WatchArea; onChange: (area: WatchArea) => void };

const RADIUS_PRESETS = [3, 7, 10, 25];
const sourceLabel: Record<WatchArea["source"], string> = {
  device: "From this device's location",
  saved: "Saved location",
  default: "Default area (not your location yet)",
};

/** "My location" + radius (statute miles). Geolocation is only requested after an explicit tap. */
export function LocationPanel({ area, onChange }: Props) {
  const ids = useId();
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [lat, setLat] = useState(String(round(area.latitude)));
  const [lon, setLon] = useState(String(round(area.longitude)));
  const [manualError, setManualError] = useState<string | null>(null);

  useEffect(() => { setLat(String(round(area.latitude))); setLon(String(round(area.longitude))); }, [area.latitude, area.longitude]);

  const locate = () => {
    if (!("geolocation" in navigator)) { setGeoError(geolocationErrorMessage(null)); return; }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        onChange({ ...area, latitude: position.coords.latitude, longitude: position.coords.longitude, source: "device", updatedAt: new Date().toISOString() });
      },
      (error) => { setLocating(false); setGeoError(geolocationErrorMessage(error.code)); },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 5 * 60_000 },
    );
  };

  const saveManual = (event: FormEvent) => {
    event.preventDefault();
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!lat.trim() || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) { setManualError("Latitude must be between -90 and 90."); return; }
    if (!lon.trim() || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) { setManualError("Longitude must be between -180 and 180."); return; }
    setManualError(null);
    onChange({ ...area, latitude, longitude, source: "saved", updatedAt: new Date().toISOString() });
  };

  const setRadius = (value: number) => onChange({ ...area, radiusMi: clampRadiusMi(value), updatedAt: new Date().toISOString() });

  return (
    <section className="panel location-panel" aria-labelledby={`${ids}-heading`}>
      <header className="panel-header">
        <div><p className="eyebrow">Watch area</p><h2 id={`${ids}-heading`}>My location & radius</h2></div>
      </header>
      <div className="location-current">
        <span className={`status-pill ${area.source === "default" ? "is-warn" : "is-ok"}`}>{sourceLabel[area.source]}</span>
        <span className="mono">{round(area.latitude)}, {round(area.longitude)}</span>
      </div>

      <div className="stack">
        <p className="muted">AIRIntel asks your browser for your location only when you tap the button. It is stored on this device and sent to the AIRIntel API only to find aircraft near you.</p>
        <button type="button" className="button button-primary button-block" onClick={locate} disabled={locating}>
          {locating && <span className="spinner" aria-hidden="true" />}{locating ? "Finding your location…" : "Use my current location"}
        </button>
        {geoError && <p className="notice notice-warn" role="alert">{geoError}</p>}
      </div>

      <div className="field">
        <label htmlFor={`${ids}-radius`}>Radius <strong className="mono">{area.radiusMi} mi</strong></label>
        <input id={`${ids}-radius`} type="range" min={MIN_WATCH_RADIUS_MI} max={MAX_WATCH_RADIUS_MI} step={1} value={area.radiusMi} onChange={(event) => setRadius(event.currentTarget.valueAsNumber)} aria-valuetext={`${area.radiusMi} miles`} />
        <div className="preset-row" role="group" aria-label="Radius presets">
          {RADIUS_PRESETS.map((preset) => <button key={preset} type="button" className="chip-toggle" aria-pressed={area.radiusMi === preset} onClick={() => setRadius(preset)}>{preset} mi</button>)}
        </div>
      </div>

      <details className="manual-location">
        <summary>Enter a location manually</summary>
        <form onSubmit={saveManual} className="manual-grid" noValidate>
          <div className="field"><label htmlFor={`${ids}-lat`}>Latitude</label><input id={`${ids}-lat`} type="number" step="any" min={-90} max={90} value={lat} onChange={(event) => setLat(event.currentTarget.value)} /></div>
          <div className="field"><label htmlFor={`${ids}-lon`}>Longitude</label><input id={`${ids}-lon`} type="number" step="any" min={-180} max={180} value={lon} onChange={(event) => setLon(event.currentTarget.value)} /></div>
          {manualError && <p className="notice notice-error manual-span" role="alert">{manualError}</p>}
          <button type="submit" className="button button-ghost manual-span">Save location</button>
        </form>
      </details>
    </section>
  );
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;
