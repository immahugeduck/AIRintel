import type { NettedAircraft } from "../domain/netted";
import type { RadiusRow } from "../domain/radius-list";
import { formatAltitudeFt, formatDistanceMi, formatLastSeen, formatSpeedMph } from "../domain/units";

type Props = {
  icao24: string;
  row: RadiusRow | null;
  netted: NettedAircraft | null;
  onClose: () => void;
  onShowMap?: (() => void) | undefined;
  onDetails: () => void;
};

/** Compact selected-aircraft card: docked above the tab bar on phones, floating over the map on desktop. */
export function SelectedDock({ icao24, row, netted, onClose, onShowMap, onDetails }: Props) {
  const callsign = row?.callsign ?? netted?.callsign ?? null;
  return (
    <aside className="selected-dock" aria-label="Selected aircraft">
      <div className="selected-head">
        <div>
          <p className="eyebrow">Selected · <span className="mono">{icao24.toUpperCase()}</span></p>
          <h2 className="mono">{callsign ?? "Unknown call sign"}</h2>
        </div>
        <button type="button" className="icon-button" aria-label="Clear selection" onClick={onClose}>✕</button>
      </div>
      {row ? (
        <dl className="selected-facts">
          <div><dt>Distance</dt><dd className="mono">{formatDistanceMi(row.distanceNm)}</dd></div>
          <div><dt>Altitude</dt><dd className="mono">{formatAltitudeFt(row.altitudeFt, row.onGround)}</dd></div>
          <div><dt>Speed</dt><dd className="mono">{formatSpeedMph(row.groundSpeedKt)}</dd></div>
          <div><dt>Last seen</dt><dd>{formatLastSeen(row.observedAt)}</dd></div>
        </dl>
      ) : netted ? (
        <dl className="selected-facts">
          <div><dt>Entries</dt><dd className="mono">{netted.visitCount}</dd></div>
          <div><dt>Closest</dt><dd className="mono">{netted.closestApproachMi.toFixed(1)} mi</dd></div>
          <div><dt>Last seen</dt><dd>{formatLastSeen(netted.lastSeenAt)}</dd></div>
        </dl>
      ) : <p className="muted">Not currently inside your radius.</p>}
      <div className="selected-actions">
        {onShowMap && <button type="button" className="button button-ghost" onClick={onShowMap}>Show on map</button>}
        <button type="button" className="button button-primary" onClick={onDetails}>Replay & profile</button>
      </div>
    </aside>
  );
}
