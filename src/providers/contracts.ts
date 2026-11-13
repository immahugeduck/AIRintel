import type { AircraftObservation, RadiusQuery } from "../domain/aircraft";

export interface AircraftProvider {
  readonly name: string;
  getAircraftInRadius(query: RadiusQuery, signal?: AbortSignal): Promise<AircraftObservation[]>;
}

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super("A documented live aircraft provider has not been configured.");
    this.name = "ProviderNotConfiguredError";
  }
}

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Sign in is required to access recorded aircraft history.");
    this.name = "AuthenticationRequiredError";
  }
}

/** The user is signed in but lacks the access grant (e.g. `history`) required by the route. */
export class AccessDeniedError extends Error {
  constructor(readonly scope: "history" | "profile") {
    super(scope === "history" ? "Recorded-history access is turned off for this account." : "Aircraft-profile access is turned off for this account.");
    this.name = "AccessDeniedError";
  }
}
