import { useId, useState } from "react";
import type { GeocodeResult } from "../domain/geocode";
import { AddressSearch } from "./AddressSearch";
import { MAX_WATCH_RADIUS_MI, MIN_WATCH_RADIUS_MI } from "../domain/units";
import type { FollowState } from "../lib/use-follow-me";
import { FOLLOW_RECENTER_MI, clampRadiusMi, geolocationErrorMessage, type WatchArea } from "../lib/watch-area";

type Props = { area: WatchArea; onChange: (area: WatchArea) => void; follow?: FollowState };

const RADIUS_PRESETS = [3, 7, 10, 25];
const sourceLabel: Record<WatchArea["source"], string> = {
  device: "From this device's location",
  saved: "Saved location",
  default: "Default area (not your location yet)",
};

/** "My location" + radius (statute miles). Geolocation is only requested after an explicit tap. */
export function LocationPanel({ area, onChange, follow = { kind: "off" } }: Props) {
  const ids = useId();
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

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

  // A manually chosen center is a fixed place: it turns follow me off so the next fix does not move it away.
  const saveManual = (place: GeocodeResult) =>
    onChange({ ...area, latitude: place.latitude, longitude: place.longitude, source: "saved", followMe: false, updatedAt: new Date().toISOString() });

  const setFollow = (followMe: boolean) => onChange({ ...area, followMe, updatedAt: new Date().toISOString() });

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

      <div className="switch-row follow-row">
        <div className="switch-copy">
          <label id={`${ids}-follow-label`} htmlFor={`${ids}-follow`}>Follow me</label>
          <span id={`${ids}-follow-desc`} className="fine-print">
            {area.followMe ? followText(follow) : `Re-centers the watch circle when your phone moves more than ${FOLLOW_RECENTER_MI} mi, while the app is open. Each logged entry keeps the location it was measured from.`}
          </span>
        </div>
        <button id={`${ids}-follow`} type="button" role="switch" className="switch" aria-checked={area.followMe === true} aria-labelledby={`${ids}-follow-label`} aria-describedby={`${ids}-follow-desc`} onClick={() => setFollow(!area.followMe)}>
          <span className="switch-thumb" aria-hidden="true" />
        </button>
      </div>
      {area.followMe && follow.kind === "error" && <p className="notice notice-warn" role="alert">{follow.message}</p>}

      <div className="field">
        <label htmlFor={`${ids}-radius`}>Radius <strong className="mono">{area.radiusMi} mi</strong></label>
        <input id={`${ids}-radius`} type="range" min={MIN_WATCH_RADIUS_MI} max={MAX_WATCH_RADIUS_MI} step={1} value={area.radiusMi} onChange={(event) => setRadius(event.currentTarget.valueAsNumber)} aria-valuetext={`${area.radiusMi} miles`} />
        <div className="preset-row" role="group" aria-label="Radius presets">
          {RADIUS_PRESETS.map((preset) => <button key={preset} type="button" className="chip-toggle" aria-pressed={area.radiusMi === preset} onClick={() => setRadius(preset)}>{preset} mi</button>)}
        </div>
      </div>

      <details className="manual-location">
        <summary>Enter a location manually</summary>
        <AddressSearch onPick={saveManual} confirmLabel="Use this location" />
      </details>
    </section>
  );
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

function followText(follow: FollowState): string {
  switch (follow.kind) {
    case "waiting": return "Waiting for your phone's location…";
    case "following": return `Following your phone${follow.accuracyM !== null ? ` (±${Math.round(follow.accuracyM)} m)` : ""}. The circle moves after ${FOLLOW_RECENTER_MI} mi; it stays put while the app is closed.`;
    case "error": return "Follow me is on but your location is unavailable.";
    default: return "Follow me is on.";
  }
}
