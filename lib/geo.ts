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

/**
 * Local flat-earth projection to metres, anchored at a reference point.
 *
 * Scoring does millions of point-to-geometry distance tests, and haversine on
 * every one of them is the whole runtime. Over a city-sized area an
 * equirectangular projection is accurate to well under a metre — far below the
 * resolution at which "is this edge near a park" means anything — and it turns
 * every distance into ordinary Euclidean arithmetic.
 */
export function projector(lon0: number, lat0: number) {
  const mPerDegLat = 110_574;
  const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    x: (lon: number) => (lon - lon0) * mPerDegLon,
    y: (lat: number) => (lat - lat0) * mPerDegLat,
  };
}

/** Squared distance from (px,py) to the segment (ax,ay)–(bx,by). */
export function distSqToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  // Degenerate segment — both endpoints coincide.
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;

  const cx = px - (ax + t * dx);
  const cy = py - (ay + t * dy);
  return cx * cx + cy * cy;
}

/** Shortest distance in metres from a point to a projected polyline. */
export function distToPolyline(
  px: number,
  py: number,
  xs: Float64Array,
  ys: Float64Array,
): number {
  if (xs.length === 0) return Infinity;
  if (xs.length === 1) return Math.hypot(px - xs[0], py - ys[0]);

  let best = Infinity;
  for (let i = 1; i < xs.length; i++) {
    const d = distSqToSegment(px, py, xs[i - 1], ys[i - 1], xs[i], ys[i]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * Ray-casting point-in-ring test. Used to make "inside a park" score the same
 * as standing on its edge rather than decaying to nothing in the middle of
 * Central Park — which is what a boundary-distance-only model would do.
 */
export function pointInRing(
  px: number,
  py: number,
  xs: Float64Array,
  ys: Float64Array,
): boolean {
  let inside = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    const yi = ys[i];
    const yj = ys[j];
    if (yi > py !== yj > py) {
      const xCross = xs[i] + ((py - yi) / (yj - yi)) * (xs[j] - xs[i]);
      if (px < xCross) inside = !inside;
    }
  }
  return inside;
}
