import { useId, useState, type FormEvent } from "react";
import { GeocodeError, lookupAddress } from "../api/geocode";
import type { GeocodeResult } from "../domain/geocode";

type Props = {
  /** Called once the user confirms the match. */
  onPick: (result: GeocodeResult) => void;
  /** Label on the confirm button, e.g. "Use this location". */
  confirmLabel: string;
  label?: string;
};

const sourceNote: Record<GeocodeResult["source"], string> = {
  coordinates: "typed coordinates",
  us_census: "U.S. Census Bureau geocoder",
  openstreetmap: "OpenStreetMap",
};

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** Address / town / "lat, lon" box with a find step and an explicit confirm, so a wrong match is never saved silently. */
export function AddressSearch({ onPick, confirmLabel, label = "Address or place" }: Props) {
  const ids = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [match, setMatch] = useState<GeocodeResult | null>(null);

  const find = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMatch(null);
    try {
      setMatch(await lookupAddress(text));
    } catch (failure) {
      setError(failure instanceof GeocodeError ? failure.message : "The address could not be looked up. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="address-search">
      <form onSubmit={find} className="manual-grid" noValidate>
        <div className="field manual-span">
          <label htmlFor={`${ids}-q`}>{label}</label>
          <input id={`${ids}-q`} type="text" autoComplete="street-address" maxLength={200} value={text} onChange={(e) => { setText(e.currentTarget.value); setMatch(null); }} placeholder="123 Main St, Springfield, IL — or a town, or 39.78, -89.65" />
        </div>
        <button type="submit" className="button button-ghost manual-span" disabled={busy || text.trim().length < 3}>
          {busy && <span className="spinner" aria-hidden="true" />}{busy ? "Finding…" : "Find"}
        </button>
      </form>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {match && (
        <div className="notice" role="status">
          <p><strong>{match.label}</strong></p>
          <p className="fine-print mono">{round(match.latitude)}, {round(match.longitude)} · {sourceNote[match.source]}</p>
          <button type="button" className="button button-primary" onClick={() => { onPick(match); setMatch(null); setText(""); }}>{confirmLabel}</button>
        </div>
      )}
    </div>
  );
}
