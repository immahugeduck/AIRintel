import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { deleteControlArea, fetchControlAreas, saveControlArea } from "../api/net";
import { MAX_CONTROL_AREAS, MIN_CONTROL_SEPARATION_MI, formatAgo, type ControlArea, type ControlAreaInput } from "../domain/net";
import { MAX_WATCH_RADIUS_MI, MIN_WATCH_RADIUS_MI, WATCH_RADIUS_MI } from "../domain/units";
import { describeNetError } from "../lib/use-net";
import type { GeocodeResult } from "../domain/geocode";
import { AddressSearch } from "./AddressSearch";

type Props = { signedIn: boolean; onSignIn: () => void };

const QUERY_KEY = ["control-areas"] as const;
const round = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Control circles: one or two fixed places the user does NOT go. The always-on sweep counts the aircraft in them, so
 * "aircraft seen near me" can be compared with a baseline. Pattern flags use the comparison (pass 4).
 */
export function ControlCircles({ signedIn, onSignIn }: Props) {
  const ids = useId();
  const client = useQueryClient();
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: ({ signal }) => fetchControlAreas(signal), enabled: signedIn, refetchInterval: 5 * 60_000, retry: false });
  const [error, setError] = useState<string | null>(null);
  const onDone = (data: Awaited<ReturnType<typeof fetchControlAreas>>) => { setError(null); client.setQueryData(QUERY_KEY, data); void client.invalidateQueries({ queryKey: ["netted-aircraft"] }); };
  const save = useMutation({ mutationFn: saveControlArea, onSuccess: onDone, onError: (e) => setError(e instanceof Error ? e.message : "Could not save the control circle.") });
  const remove = useMutation({ mutationFn: deleteControlArea, onSuccess: onDone, onError: (e) => setError(e instanceof Error ? e.message : "Could not remove the control circle.") });

  const areas = query.data?.controlAreas ?? [];
  const freeSlot = [1, 2].find((slot) => !areas.some((area) => area.slot === slot)) ?? null;

  return (
    <section className="panel control-circles" aria-labelledby={`${ids}-heading`}>
      <header className="panel-header">
        <div><p className="eyebrow">Comparison</p><h2 id={`${ids}-heading`}>Control circles</h2></div>
      </header>
      <p className="muted">
        Add up to {MAX_CONTROL_AREAS} fixed circles somewhere you do <strong>not</strong> go (at least {MIN_CONTROL_SEPARATION_MI} mi from your watch area). The net counts the aircraft there too, so you can tell ordinary local traffic from aircraft that keep showing up where you are.
      </p>

      {!signedIn && (
        <div className="notice notice-warn" role="status">
          <p>Sign in to add control circles.</p>
          <button type="button" className="button button-primary" onClick={onSignIn}>Sign in</button>
        </div>
      )}
      {signedIn && query.isLoading && <p className="notice" role="status"><span className="spinner" aria-hidden="true" /> Loading control circles…</p>}
      {signedIn && query.isError && <p className="notice notice-warn" role="alert">{describeNetError(query.error).message}</p>}

      {query.data && (
        <>
          <table className="control-compare">
            <caption className="fine-print">Distinct aircraft, last {query.data.windowDays} days</caption>
            <tbody>
              <tr><th scope="row">Your circle</th><td className="mono">{query.data.yourAircraftSeen}</td><td /></tr>
              {areas.map((area) => <ControlRow key={area.slot} area={area} busy={remove.isPending} onRemove={() => remove.mutate(area.slot)} />)}
            </tbody>
          </table>
          {freeSlot !== null && <AddControlForm slot={freeSlot} saving={save.isPending} onSave={(input) => save.mutate(input)} />}
        </>
      )}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <p className="fine-print">Control counts start with the next sweep after you add a circle and only accumulate while the always-on net is running.</p>
    </section>
  );
}

function ControlRow({ area, busy, onRemove }: { area: ControlArea; busy: boolean; onRemove: () => void }) {
  const swept = formatAgo(area.lastSuccessAt);
  return (
    <tr>
      <th scope="row">
        {area.label || `Control ${area.slot}`}
        <span className="fine-print"> · {round(area.latitude)}, {round(area.longitude)} · {area.radiusMi} mi · {swept ? `swept ${swept}` : "waiting for first sweep"}</span>
      </th>
      <td className="mono">{area.lastSuccessAt ? area.aircraftSeen : "—"}</td>
      <td><button type="button" className="button button-ghost" onClick={onRemove} disabled={busy}>Remove</button></td>
    </tr>
  );
}

function AddControlForm({ slot, saving, onSave }: { slot: number; saving: boolean; onSave: (input: ControlAreaInput) => void }) {
  const ids = useId();
  const [label, setLabel] = useState("");
  const [place, setPlace] = useState<GeocodeResult | null>(null);
  const [radius, setRadius] = useState(String(WATCH_RADIUS_MI));
  const [formError, setFormError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const radiusMi = Number(radius);
    if (!place) { setFormError("Find the control circle's address or place first."); return; }
    if (!Number.isFinite(radiusMi) || radiusMi < MIN_WATCH_RADIUS_MI || radiusMi > MAX_WATCH_RADIUS_MI) { setFormError(`Radius must be ${MIN_WATCH_RADIUS_MI}–${MAX_WATCH_RADIUS_MI} mi.`); return; }
    setFormError(null);
    onSave({ slot, label: label.trim(), latitude: place.latitude, longitude: place.longitude, radiusMi, enabled: true });
  };
  return (
    <details className="manual-location">
      <summary>Add control circle {slot}</summary>
      {place ? (
        <p className="notice" role="status">
          Center: <strong>{place.label}</strong> <span className="fine-print mono">({round(place.latitude)}, {round(place.longitude)})</span>{" "}
          <button type="button" className="link-button" onClick={() => setPlace(null)}>Change</button>
        </p>
      ) : (
        <AddressSearch onPick={(picked) => { setPlace(picked); setFormError(null); }} confirmLabel="Use as circle center" label="Center address or place" />
      )}
      <form onSubmit={submit} className="manual-grid" noValidate>
        <div className="field manual-span"><label htmlFor={`${ids}-label`}>Name (optional)</label><input id={`${ids}-label`} maxLength={40} value={label} onChange={(e) => setLabel(e.currentTarget.value)} placeholder="e.g. Across town" /></div>
        <div className="field"><label htmlFor={`${ids}-radius`}>Radius (mi)</label><input id={`${ids}-radius`} type="number" step={1} min={MIN_WATCH_RADIUS_MI} max={MAX_WATCH_RADIUS_MI} value={radius} onChange={(e) => setRadius(e.currentTarget.value)} /></div>
        {formError && <p className="notice notice-error manual-span" role="alert">{formError}</p>}
        <button type="submit" className="button button-ghost manual-span" disabled={saving || !place}>{saving ? "Saving…" : "Save control circle"}</button>
      </form>
    </details>
  );
}
