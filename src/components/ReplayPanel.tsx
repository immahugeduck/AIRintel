import { useMemo } from "react";
import { segmentTracksByProvider, type TrackPoint } from "../domain/aircraft";

type Props = { points: TrackPoint[]; aircraftLabel: string; index: number; onIndexChange: (index: number) => void };

export function ReplayPanel({ points, aircraftLabel, index, onIndexChange }: Props) {
  const ordered = useMemo(() => [...points].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)), [points]);
  const providerTracks = useMemo(() => segmentTracksByProvider(ordered), [ordered]);
  const safeIndex = Math.min(index, ordered.length - 1);
  const point = ordered[safeIndex];
  const gapCount = providerTracks.reduce((count, track) => count + track.segments.filter((segment) => segment.kind === "gap").length, 0);
  if (!point) return null;

  return (
    <section className="replay" aria-labelledby="replay-heading">
      <div className="replay-title"><div><p className="eyebrow">Observed history</p><h3 id="replay-heading">24-hour replay · {aircraftLabel}</h3></div><span>{gapCount} data {gapCount === 1 ? "gap" : "gaps"}</span></div>
      <label htmlFor="replay-timeline">Replay observation {safeIndex + 1} of {ordered.length}</label>
      <input id="replay-timeline" type="range" min={0} max={ordered.length - 1} value={safeIndex} aria-valuetext={`${new Date(point.observedAt).toISOString()}, source ${point.provider}`} onChange={(event) => onIndexChange(event.currentTarget.valueAsNumber)} />
      <dl className="replay-facts" aria-live="polite">
        <div><dt>Observed UTC</dt><dd>{new Date(point.observedAt).toISOString()}</dd></div>
        <div><dt>Altitude</dt><dd>{point.altitudeFt == null ? "Unknown" : `${Math.round(point.altitudeFt).toLocaleString()} ft (${point.altitudeSource})`}</dd></div>
        <div><dt>Ground speed</dt><dd>{point.groundSpeedKt == null ? "Unknown" : `${Math.round(point.groundSpeedKt)} kt`}</dd></div>
        <div><dt>Source</dt><dd>{point.provider}</dd></div>
      </dl>
      {providerTracks.length > 1 && <p className="gap-note">Observed: {providerTracks.length} provider streams are kept separate; AIRIntel does not connect cross-source points.</p>}
      {gapCount > 0 && <p className="gap-note">Calculated: per-source reception gaps exceed 120 seconds. AIRIntel does not interpolate positions across them.</p>}
    </section>
  );
}
