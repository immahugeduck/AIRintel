/** Deterministic spherical geometry; distances are nautical miles. */
const EARTH_RADIUS_NM = 3440.065;
const radians = (degrees: number) => degrees * Math.PI / 180;
const degrees = (value: number) => value * 180 / Math.PI;

export function distanceNm(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const a = Math.sin(radians(latitude2 - latitude1) / 2) ** 2
    + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(radians(longitude2 - longitude1) / 2) ** 2;
  const clamped = Math.min(1, Math.max(0, a));
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

/** Bounds do not require a Leaflet layer to have been attached to a map. */
export function watchAreaBounds(latitude: number, longitude: number, radiusNm: number): [[number, number], [number, number]] {
  const angle = radiusNm / EARTH_RADIUS_NM;
  const latitudeDelta = degrees(angle);
  const south = Math.max(-90, latitude - latitudeDelta);
  const north = Math.min(90, latitude + latitudeDelta);
  const longitudeDelta = south === -90 || north === 90 ? 180
    : degrees(Math.asin(Math.min(1, Math.sin(angle) / Math.cos(radians(latitude)))));
  return [[south, longitude - longitudeDelta], [north, longitude + longitudeDelta]];
}
