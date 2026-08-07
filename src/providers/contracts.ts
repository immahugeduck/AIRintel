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
