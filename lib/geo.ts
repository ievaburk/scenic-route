/** Metres between two [lon, lat] points. */
export function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Total length in metres of a flat [lon, lat, lon, lat, ...] polyline. */
export function polylineLengthM(flat: number[]): number {
  let total = 0;
  for (let i = 2; i < flat.length; i += 2) {
    total += haversineM(
      [flat[i - 2], flat[i - 1]],
      [flat[i], flat[i + 1]],
    );
  }
  return total;
}
