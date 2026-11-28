import type { NettedVisit } from "../domain/netted";
import { replayIndexAt, replayContext } from "../domain/replay";
import { useEffect, useMemo, useState } from "react";
import { segmentTracksByProvider, type TrackPoint } from "../domain/aircraft";

type Props = { visit?: NettedVisit | undefined; title?: string; points: TrackPoint[]; aircraftLabel: string; index: number; onIndexChange: (index: number) => void };

export function ReplayPanel({ title = "24-hour replay", points, visit, aircraftLabel, index, onIndexChange }: Props) {
  const ordered = useMemo(() => [...points].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)), [points]);
  const context = useMemo(() => visit ? replayContext(points, visit) : null, [points, visit]);
  const providerTracks = useMemo(() => segmentTracksByProvider(ordered), [ordered]);
  const safeIndex = Math.max(0, Math.min(index, ordered.length - 1));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const times = useMemo(() => ordered.map((p) => Date.parse(p.observedAt)), [ordered]);
  const nextTime = times[safeIndex + 1];
  const currentTime = times[safeIndex];
  useEffect(() => {
    if (!playing || nextTime === undefined) { setPlaying(false); return; }
    const delay = Math.max(1, (nextTime - currentTime!) / speed);
    const timer = window.setTimeout(() => onIndexChange(safeIndex + 1), delay);
    return () => window.clearTimeout(timer);
  }, [playing, speed, safeIndex, nextTime, currentTime, onIndexChange]);
  useEffect(() => {
    const pause = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, []);
  const point = ordered[safeIndex];
  const gapCount = providerTracks.reduce((count, track) => count + track.segments.filter((segment) => segment.kind === "gap").length, 0);
  if (!point) return null;

  return (
    <section className="replay" aria-labelledby="replay-heading">
      <div className="replay-title"><div><p className="eyebrow">Observed history</p><h3 id="replay-heading">{title} · {aircraftLabel}</h3></div><span>{gapCount} data {gapCount === 1 ? "gap" : "gaps"}</span></div>
      <label htmlFor="replay-timeline">Replay observation {safeIndex + 1} of {ordered.length}</label>
      <div className="replay-controls">
        <button type="button" className="button button-ghost" disabled={ordered.length < 2} onClick={() => { if (safeIndex >= ordered.length - 1) onIndexChange(0); setPlaying(!playing); }}>{playing ? "Pause" : "Play"}</button>
        <button type="button" className="button button-ghost" disabled={safeIndex === 0} onClick={() => { setPlaying(false); onIndexChange(Math.max(0, safeIndex - 1)); }}>Previous</button>
        <button type="button" className="button button-ghost" disabled={safeIndex >= ordered.length - 1} onClick={() => { setPlaying(false); onIndexChange(Math.min(ordered.length - 1, safeIndex + 1)); }}>Next</button>
        <label>Playback speed <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>{[1, 10, 30, 60].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
      </div>
      <input id="replay-timeline" type="range" min={times[0]} max={times[times.length - 1]} step={1} value={times[safeIndex]} disabled={ordered.length < 2} aria-valuetext={`${new Date(point.observedAt).toISOString()}, source ${point.provider}`} onChange={(event) => { setPlaying(false); onIndexChange(replayIndexAt(times, event.currentTarget.valueAsNumber)); }} />
      <p className="fine-print">Playback uses elapsed observation time. During gaps the marker stays at the last recorded position; no positions are interpolated.</p>
      <dl className="replay-facts" aria-live="polite">
        <div><dt>Observed UTC</dt><dd>{new Date(point.observedAt).toISOString()}</dd></div>
        <div><dt>Altitude</dt><dd>{point.altitudeFt == null ? "Unknown" : `${Math.round(point.altitudeFt).toLocaleString()} ft (${point.altitudeSource})`}</dd></div>
        <div><dt>Ground speed</dt><dd>{point.groundSpeedKt == null ? "Unknown" : `${Math.round(point.groundSpeedKt)} kt`}</dd></div>
        <div><dt>Source</dt><dd>{point.provider}</dd></div>
      </dl>
      {visit && <details><summary>Approach, nearby activity and departure</summary>
        {context ? context.map((stream) => <p key={stream.provider} className="fine-print">Calculated · {stream.provider}: {stream.approach} samples before entry, {stream.departure} after the last inside sighting; {stream.nearOutside} outside samples within 3× the saved radius; {stream.entries} observed outside-to-inside transitions within 120 seconds. Measured against the saved entry center.</p>) : <p className="fine-print">Unknown — historical center or radius is unavailable.</p>}
        <p className="fine-print">Transitions here are per-source evidence within this replay window; they do not change saved counts or prove continuous reception. A moving follow-me center can change these retrospective results.</p>
      </details>}
      {providerTracks.length > 1 && <p className="gap-note">Observed: {providerTracks.length} provider streams are kept separate; AIRIntel does not connect cross-source points.</p>}
      {gapCount > 0 && <p className="gap-note">Calculated: per-source reception gaps exceed 120 seconds. AIRIntel does not interpolate positions across them.</p>}
    </section>
  );
}
