/**
 * Pilot area: Manhattan below 125th St + brownstone Brooklyn.
 *
 * Deliberately not all five boroughs — the graph has to stay small enough to
 * hold in memory in one process, and small enough that the scenic scoring can
 * be eyeballed against real knowledge of the streets.
 */
export const PILOT = {
  name: "nyc",
  bbox: { south: 40.655, west: -74.02, north: 40.812, east: -73.93 },
  /** Overpass is happier with many small queries than one huge one. */
  tile: { lat: 0.02, lon: 0.03 },
} as const;

export type BBox = { south: number; west: number; north: number; east: number };

/** Flat-ground walking speed. Elevation is out of scope for v1 (fine in NYC). */
export const WALK_SPEED_MPS = 1.35;

/** Stairs are much slower than the flat-ground assumption. */
export const STAIRS_SPEED_MPS = 0.55;

/**
 * Ways a pedestrian can legally and plausibly walk along. Motorways and trunk
 * roads are excluded outright; everything else is filtered further by access
 * tags at graph-build time.
 */
export const WALKABLE_HIGHWAY_VALUES = [
  "footway",
  "path",
  "pedestrian",
  "steps",
  "living_street",
  "residential",
  "service",
  "unclassified",
  "tertiary",
  "tertiary_link",
  "secondary",
  "secondary_link",
  "primary",
  "primary_link",
  "track",
  "cycleway",
] as const;

/** Split the pilot bbox into tiles for chunked, cacheable Overpass fetches. */
export function tiles(bbox: BBox = PILOT.bbox, size = PILOT.tile): BBox[] {
  const out: BBox[] = [];
  for (let s = bbox.south; s < bbox.north; s += size.lat) {
    for (let w = bbox.west; w < bbox.east; w += size.lon) {
      out.push({
        south: round6(s),
        west: round6(w),
        north: round6(Math.min(s + size.lat, bbox.north)),
        east: round6(Math.min(w + size.lon, bbox.east)),
      });
    }
  }
  return out;
}

function round6(n: number) {
  return Math.round(n * 1e6) / 1e6;
}
