import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelectedDock } from "./SelectedDock";
import { AircraftProfilePanel } from "./AircraftProfilePanel";
import { buildRadiusRows } from "../domain/radius-list";
import type { AircraftProfile } from "../domain/profile";

// Synthetic UI vectors only, not real aircraft or registry facts.
const observedAt = "2026-11-08T12:00:00Z";
const missing = { value: null, status: "unknown", evidenceLevel: "unknown", source: "FAA registry", sourceRecordId: null, sourceEffectiveAt: null, matchMethod: null, limitations: [] } as const;
const profile: AircraftProfile = {
  aircraftId: "11111111-1111-4111-8111-111111111111", icao24: "abcdef", observedRegistration: "N99ZZ",
  firstObservedAt: observedAt, lastObservedAt: observedAt, receivedAt: observedAt,
  registryMatch: { status: "unmatched", method: null, snapshotEffectiveAt: null, nNumber: { ...missing, limitations: [] }, manufacturer: { ...missing, limitations: [] }, model: { ...missing, limitations: [] }, serialNumber: { ...missing, limitations: [] }, registrationStatus: { ...missing, limitations: [] }, registeredOwner: { ...missing, limitations: [] } },
  operator: { documentedOperator: { ...missing, limitations: [] }, actualOperatorForFlight: "Unknown" }, statisticsBySource: [],
};

describe("aircraft identity presentation", () => {
  it("shows registration and type already supplied by the live gateway", () => {
    const row = buildRadiusRows([{ icao24: "abcdef", registration: "N99ZZ", callsign: "TEST101", aircraftTypeCode: "TEST", latitude: 1, longitude: 2, observedAt }], [], { latitude: 1, longitude: 2 }, 7)[0]!;
    const html = renderToStaticMarkup(<SelectedDock icao24="abcdef" row={row} netted={null} onClose={() => undefined} onDetails={() => undefined} />);
    expect(html).toContain("Registration (provider-reported)");
    expect(html).toContain("N99ZZ");
    expect(html).toContain("Type (provider-reported)");
    expect(html).toContain(">TEST</dd>");
  });
  it("keeps genuinely missing provider identity unknown without guessing from callsign", () => {
    const row = buildRadiusRows([{ icao24: "abcdef", callsign: "N99ZZ", latitude: 1, longitude: 2, observedAt }], [], { latitude: 1, longitude: 2 }, 7)[0]!;
    const html = renderToStaticMarkup(<SelectedDock icao24="abcdef" row={row} netted={null} onClose={() => undefined} onDetails={() => undefined} />);
    expect(html).toContain('Registration (provider-reported)</dt><dd class="mono">Unknown</dd>');
    expect(html).toContain('Type (provider-reported)</dt><dd class="mono">Unknown</dd>');
  });
  it("does not claim a missing match when a registry match exists", () => {
    const html = renderToStaticMarkup(<AircraftProfilePanel profile={{ ...profile, registryMatch: { ...profile.registryMatch, status: "confirmed" } }} />);
    expect(html).not.toContain("No matched FAA registry record is available");
  });
  it("distinguishes a missing published source from an aircraft with no exact match", () => {
    const html = renderToStaticMarkup(<AircraftProfilePanel profile={{ ...profile, registryMatch: { ...profile.registryMatch, unavailableReason: "no_published_snapshot" } }} />);
    expect(html).toContain("No published FAA registry snapshot is available");
    expect(html).toContain("N99ZZ");
  });
  it("explains when retained identity provenance is unavailable", () => {
    const html = renderToStaticMarkup(<AircraftProfilePanel profile={{ ...profile, registryMatch: { ...profile.registryMatch, unavailableReason: "identity_unverified" } }} />);
    expect(html).toContain("ICAO identity provenance is unavailable");
  });
  it("warns that conflicting registry evidence is withheld instead of displaying an owner", () => {
    const html = renderToStaticMarkup(<AircraftProfilePanel profile={{ ...profile, registryMatch: { ...profile.registryMatch, status: "conflict", unavailableReason: "conflict" } }} />);
    expect(html).toContain("Conflicting FAA identity evidence");
  });
  it("explains missing registry evidence instead of silently presenting all fields as unknown", () => {
    const html = renderToStaticMarkup(<AircraftProfilePanel profile={profile} />);
    expect(html).toContain("No matched FAA registry record is available");
    expect(html).toContain("Registration (provider-reported)");
    expect(html).toContain("N99ZZ");
    expect(html).not.toContain("FAA-verified registration");
  });
});
