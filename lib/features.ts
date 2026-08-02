/**
 * The scenic vocabulary: what counts as interesting, and how far it carries.
 *
 * This file is deliberately the only place that opinion lives. The Overpass
 * selectors and the tag→axis classification sit side by side because they have
 * to agree — a selector with no matching rule fetches megabytes that score
 * nothing, and a rule with no selector silently never fires.
 *
 * The fetch is intentionally *broader* than the classification: one query per
 * tile pulls everything plausibly scenic, and categorisation happens at score
 * time. Retuning what "architecture" means is then a re-run of `score:graph`
 * (seconds) rather than a re-fetch from Overpass (many minutes, rate-limited).
 */

/**
 * Six axes, matching PLAN.md §4. `quiet` is the odd one out: nothing in OSM
 * tags it, so it's derived from the edge's own road class rather than from
 * nearby features — see `quietScore` in `lib/scoring.ts`.
 */
export const SCENIC_AXES = [
  { key: "green", label: "Green", color: "#16a34a" },
  { key: "water", label: "Water", color: "#0ea5e9" },
  { key: "architecture", label: "Architecture / historic", color: "#b45309" },
  { key: "art", label: "Art & landmarks", color: "#db2777" },
  { key: "quiet", label: "Quiet", color: "#6366f1" },
  { key: "hills", label: "Hills & views", color: "#7c3aed" },
] as const;

export type ScenicAxis = (typeof SCENIC_AXES)[number]["key"];

export const AXIS_KEYS = SCENIC_AXES.map((a) => a.key) as ScenicAxis[];

/** Even weights to start. Phase 6 learns these per user (PLAN.md §10). */
export const DEFAULT_WEIGHTS: Record<ScenicAxis, number> = {
  green: 1,
  water: 1,
  architecture: 1,
  art: 1,
  quiet: 1,
  hills: 1,
};

/**
 * Overpass selectors for one tile. `nwr` matches nodes, ways and relations in
 * one go; `out geom` inlines coordinates, which saves the second
 * node-resolution pass that the road network needs.
 *
 * Kept broad on purpose (see the file header) — anything arguably scenic comes
 * down once and gets sorted out locally.
 */
export const FEATURE_SELECTORS = [
  `nwr["leisure"~"^(park|garden|nature_reserve|dog_park)$"]`,
  `nwr["landuse"~"^(grass|forest|meadow|village_green|recreation_ground|cemetery)$"]`,
  `nwr["natural"~"^(water|coastline|wood|scrub|grassland|tree|peak)$"]`,
  `nwr["waterway"~"^(river|canal|stream)$"]`,
  `nwr["man_made"~"^(pier|bridge)$"]`,
  `nwr["historic"]`,
  `nwr["heritage"]`,
  `nwr["tourism"~"^(artwork|attraction|viewpoint|museum|gallery)$"]`,
  `nwr["amenity"~"^(fountain|place_of_worship)$"]`,
  `nwr["building"~"^(church|cathedral|chapel|synagogue|mosque|temple)$"]`,
];

/**
 * One feature's contribution to one axis.
 *
 * `reach` is where influence has decayed to nothing, in metres, and it varies
 * by how big the thing actually is: a park is worth something from a block
 * away, a plaque is worth something from across the street and no further.
 * Getting these wrong in the generous direction is what turns a scenic map
 * into a uniformly warm blur.
 */
export type Contribution = {
  axis: ScenicAxis;
  /** Intrinsic strength before distance decay, 0–1. */
  weight: number;
  /** Metres at which the contribution reaches zero. */
  reach: number;
};

type Rule = {
  key: string;
  /** Matches any of these values; omit to match the key's mere presence. */
  values?: string[];
  axis: ScenicAxis;
  weight: number;
  reach: number;
};

/**
 * Order doesn't matter — every matching rule contributes. A historic fountain
 * legitimately counts as both art and architecture, and double-counting across
 * *different* axes is correct: it really is two kinds of interesting.
 */
const RULES: Rule[] = [
  // ---- Green ------------------------------------------------------------
  { key: "leisure", values: ["park", "nature_reserve"], axis: "green", weight: 1, reach: 150 },
  { key: "leisure", values: ["garden"], axis: "green", weight: 0.8, reach: 100 },
  { key: "leisure", values: ["dog_park"], axis: "green", weight: 0.5, reach: 80 },
  { key: "landuse", values: ["forest"], axis: "green", weight: 1, reach: 150 },
  { key: "natural", values: ["wood"], axis: "green", weight: 1, reach: 150 },
  {
    key: "landuse",
    values: ["grass", "meadow", "village_green", "recreation_ground"],
    axis: "green",
    weight: 0.6,
    reach: 100,
  },
  // Green-Wood and Trinity are genuinely among the nicest walks in the pilot area.
  { key: "landuse", values: ["cemetery"], axis: "green", weight: 0.5, reach: 100 },
  { key: "natural", values: ["scrub", "grassland"], axis: "green", weight: 0.4, reach: 80 },
  // Individually trivial, collectively the whole point — a street-tree canopy
  // is what makes an ordinary block pleasant. Short reach, low weight, and it
  // adds up across the many trees along any given edge.
  { key: "natural", values: ["tree"], axis: "green", weight: 0.15, reach: 25 },

  // ---- Water ------------------------------------------------------------
  { key: "natural", values: ["water", "coastline"], axis: "water", weight: 1, reach: 200 },
  { key: "waterway", values: ["river", "canal"], axis: "water", weight: 1, reach: 200 },
  { key: "waterway", values: ["stream"], axis: "water", weight: 0.5, reach: 80 },
  { key: "man_made", values: ["pier"], axis: "water", weight: 0.8, reach: 120 },

  // ---- Architecture / historic -----------------------------------------
  { key: "heritage", axis: "architecture", weight: 0.9, reach: 60 },
  {
    key: "historic",
    values: ["building", "church", "castle", "manor", "city_gate", "district"],
    axis: "architecture",
    weight: 0.8,
    reach: 60,
  },
  { key: "historic", axis: "architecture", weight: 0.5, reach: 50 },
  {
    key: "building",
    values: ["church", "cathedral", "chapel", "synagogue", "mosque", "temple"],
    axis: "architecture",
    weight: 0.6,
    reach: 50,
  },
  { key: "amenity", values: ["place_of_worship"], axis: "architecture", weight: 0.5, reach: 50 },
  {
    key: "tourism",
    values: ["attraction", "museum", "gallery"],
    axis: "architecture",
    weight: 0.6,
    reach: 60,
  },

  // ---- Art & landmarks --------------------------------------------------
  { key: "tourism", values: ["artwork"], axis: "art", weight: 0.9, reach: 40 },
  { key: "historic", values: ["memorial"], axis: "art", weight: 0.7, reach: 40 },
  { key: "historic", values: ["monument"], axis: "art", weight: 0.9, reach: 60 },
  { key: "amenity", values: ["fountain"], axis: "art", weight: 0.8, reach: 40 },

  // ---- Hills & views ----------------------------------------------------
  { key: "tourism", values: ["viewpoint"], axis: "hills", weight: 1, reach: 150 },
  { key: "natural", values: ["peak"], axis: "hills", weight: 1, reach: 200 },
  { key: "man_made", values: ["bridge"], axis: "hills", weight: 0.6, reach: 80 },
];

/**
 * Which axes a feature's tags feed, and how strongly.
 *
 * Returns at most one contribution per axis — the strongest matching rule wins,
 * so the specific `historic=monument` rule isn't diluted by the catch-all
 * `historic=*` one sitting below it.
 */
export function classify(tags: Record<string, string>): Contribution[] {
  const best = new Map<ScenicAxis, Contribution>();

  for (const rule of RULES) {
    const value = tags[rule.key];
    if (value === undefined) continue;
    if (rule.values && !rule.values.includes(value)) continue;

    const current = best.get(rule.axis);
    if (!current || rule.weight > current.weight) {
      best.set(rule.axis, {
        axis: rule.axis,
        weight: rule.weight,
        reach: rule.reach,
      });
    }
  }

  return [...best.values()];
}

/**
 * NYC-specific whole-block signals, applied to edges inside the polygon rather
 * than by proximity decay (PLAN.md §5). These exist because OSM's single worst
 * blind spot is the *ordinary beautiful street*: `historic=*` covers monuments
 * exhaustively and a gorgeous unremarkable brownstone block not at all.
 */
export const DISTRICT_WEIGHTS: Record<string, { axis: ScenicAxis; weight: number }> = {
  // LPC-designated. The strongest "this street is beautiful" signal available
  // for NYC, and it covers exactly what OSM misses.
  nyc_historic_districts: { axis: "architecture", weight: 0.9 },
  nys_historic_districts: { axis: "architecture", weight: 0.6 },
  us_historic_places: { axis: "architecture", weight: 0.6 },
  // Designated for the view, which is the hills/views axis almost by definition.
  scenic_landmarks: { axis: "hills", weight: 0.9 },
};
