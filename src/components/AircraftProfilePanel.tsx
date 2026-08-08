import type { AircraftProfile } from "../domain/profile";

type Props = { profile: AircraftProfile };
type EvidenceField = AircraftProfile["registryMatch"]["manufacturer"];

function Field({ label, field }: { label: string; field: EvidenceField }) {
  const fallback = field.status === "withheld_or_unavailable"
    ? "Withheld or unavailable in this public FAA release"
    : "Unknown";

  return (
    <div className="profile-field">
      <dt>{label}</dt>
      <dd>{field.value ?? fallback}</dd>
      <small>
        {field.evidenceLevel} | {field.source} | {field.status.replaceAll("_", " ")}
        {field.sourceEffectiveAt ? ` | effective ${field.sourceEffectiveAt}` : ""}
      </small>
      {field.limitations.map((limitation) => <p key={limitation}>{limitation}</p>)}
    </div>
  );
}

export function AircraftProfilePanel({ profile }: Props) {
  return (
    <section className="profile-panel" aria-labelledby="profile-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Aircraft intelligence</p>
          <h2 id="profile-heading">{profile.registryMatch.nNumber.value ?? profile.observedRegistration ?? profile.icao24}</h2>
        </div>
        <span className={`match-badge ${profile.registryMatch.status}`}>{profile.registryMatch.status.replaceAll("_", " ")}</span>
      </div>
      <div className="profile-grid">
        <article>
          <h3>FAA registration record</h3>
          <dl>
            <Field label="N-number" field={profile.registryMatch.nNumber} />
            <Field label="Manufacturer" field={profile.registryMatch.manufacturer} />
            <Field label="Model / series" field={profile.registryMatch.model} />
            <Field label="Serial number" field={profile.registryMatch.serialNumber} />
            <Field label="Registration status" field={profile.registryMatch.registrationStatus} />
          </dl>
        </article>
        <article>
          <h3>Ownership and operation</h3>
          <dl>
            <Field label="Registered owner (FAA record)" field={profile.registryMatch.registeredOwner} />
            <Field label="Documented operator" field={profile.operator.documentedOperator} />
          </dl>
          <div className="unknown-callout">
            <strong>Actual operator for a particular flight</strong>
            <span>{profile.operator.actualOperatorForFlight}</span>
            <p>Registration does not establish who operated or occupied a particular flight.</p>
          </div>
        </article>
      </div>
      <article className="statistics">
        <h3>Calculated observation profile</h3>
        {profile.statisticsBySource.length === 0 ? (
          <p>No sufficient recorded observations are available for statistics.</p>
        ) : (
          <div className="statistics-grid">
            {profile.statisticsBySource.map((stats) => (
              <div key={stats.provider}>
                <strong>{stats.provider}</strong>
                <span>{stats.validObservationCount.toLocaleString()} valid observations | {stats.observedDays} UTC days</span>
                <span>Median altitude: {stats.medianAltitudeFt == null ? "Unknown - insufficient sample" : `${Math.round(stats.medianAltitudeFt).toLocaleString()} ft ${stats.altitudeBasis}`}</span>
                <span>Median ground speed: {stats.medianGroundSpeedKt == null ? "Unknown - insufficient sample" : `${Math.round(stats.medianGroundSpeedKt)} kt`}</span>
                <span>{stats.onGroundExcludedCount} on-ground observations excluded</span>
                <span>{stats.unknownGroundStateExcludedCount} observations with unknown ground state excluded</span>
                <small>{stats.windowStart} to {stats.windowEnd} | {stats.algorithmVersion}{stats.truncated ? " | truncated sample" : ""}</small>
              </div>
            ))}
          </div>
        )}
      </article>
    </section>
  );
}
