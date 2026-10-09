import type { RadiusRow } from "../domain/radius-list";
import { formatAltitudeFt, formatDistanceMi, formatLastSeen, formatSpeedMph } from "../domain/units";

type Props = {
  rows: RadiusRow[];
  selectedIcao24: string | null;
  onSelect: (icao24: string) => void;
  radiusMi: number;
  loading: boolean;
  liveError: string | null;
  recordedNote: string | null;
  /** Optional time zone override (tests/harness); defaults to the browser's zone. */
  timeZone?: string;
};

/** Clean "Aircraft in radius" list: callsign, distance (mi), altitude (ft), speed (mph), last seen. Sorted by distance. */
export function AircraftList({ rows, selectedIcao24, onSelect, radiusMi, loading, liveError, recordedNote, timeZone }: Props) {
  return (
    <section className="panel aircraft-list" aria-labelledby="radius-heading">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Within {formatRadius(radiusMi)} of my location</p>
          <h2 id="radius-heading">Aircraft in radius <span className="count-badge" aria-label={`${rows.length} aircraft`}>{rows.length}</span></h2>
        </div>
        <span className="hint">Nearest first</span>
      </header>
      {liveError && <p className="notice notice-error" role="alert">Live feed: {liveError}</p>}
      {recordedNote && <p className="notice">{recordedNote}</p>}
      {rows.length === 0 ? (
        <div className="empty-state" role="status">
          {loading ? <><span className="spinner" aria-hidden="true" /><p>Looking for aircraft…</p></> : <><span className="empty-icon" aria-hidden="true">◎</span><p><strong>No aircraft inside {formatRadius(radiusMi)} right now.</strong></p><p className="muted">The list updates automatically as aircraft are observed.</p></>}
        </div>
      ) : (
        <ul className="aircraft-rows" role="list">
          <li className="aircraft-row aircraft-row-labels" aria-hidden="true">
            <span>Call sign</span><span>Distance</span><span>Altitude</span><span>Speed</span><span>Last seen</span>
          </li>
          {rows.map((row) => {
            const selected = row.icao24 === selectedIcao24;
            return (
              <li key={row.icao24}>
                <button type="button" className={`aircraft-row${selected ? " is-selected" : ""}`} aria-pressed={selected} onClick={() => onSelect(row.icao24)}
                  aria-label={`${row.callsign ?? "Unknown call sign"}, ${formatDistanceMi(row.distanceNm)}, altitude ${formatAltitudeFt(row.altitudeFt, row.onGround)}, speed ${formatSpeedMph(row.groundSpeedKt)}, last seen ${formatLastSeen(row.observedAt, timeZone)}`}>
                  <span className="cell-callsign mono">{row.callsign ?? <span className="unknown">Unknown</span>}</span>
                  <span className="cell-distance mono" data-label="Distance">{formatDistanceMi(row.distanceNm)}</span>
                  <span className="cell-altitude mono" data-label="Altitude">{formatAltitudeFt(row.altitudeFt, row.onGround)}</span>
                  <span className="cell-speed mono" data-label="Speed">{formatSpeedMph(row.groundSpeedKt)}</span>
                  <span className="cell-seen" data-label="Last seen">{formatLastSeen(row.observedAt, timeZone)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export const formatRadius = (radiusMi: number) => `${Number.isInteger(radiusMi) ? radiusMi : radiusMi.toFixed(1)} mi`;
