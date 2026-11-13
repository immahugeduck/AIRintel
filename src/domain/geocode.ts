import { z } from "zod";

/** What the address box sends: an address, a place name, or "lat, lon". */
export const geocodeQuerySchema = z.string().trim().min(3).max(200);

export const geocodeResultSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  /** The provider's normalized name for the match, shown to the user to confirm before saving. */
  label: z.string().max(200),
  source: z.enum(["coordinates", "us_census", "openstreetmap"]),
});
export type GeocodeResult = z.infer<typeof geocodeResultSchema>;

export const geocodeResponseSchema = z.object({ result: geocodeResultSchema });

const COORDINATE_PATTERN = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** Parses typed "lat, lon" (decimal degrees) so coordinates still work without a lookup. */
export function parseCoordinateText(text: string): GeocodeResult | null {
  const match = COORDINATE_PATTERN.exec(text);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude, label: `${latitude}, ${longitude}`, source: "coordinates" };
}
