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
/**
 * `color` is the axis's identity — legend swatch, score bar in the edge panel.
 * `ramp` is the five-stop sequential scale the map colours edges with when that
 * axis is selected, running low → high.
 *
 * Every ramp starts on the same near-neutral slate so low scores recede into the
 * pale basemap rather than competing with it; only the top end carries the
 * axis's hue. That keeps "how bright is this street" readable the same way
 * across axes while making it obvious at a glance which axis you're looking at.
 */
export const SCENIC_AXES = [
  {
    key: "green",
    label: "Green",
    color: "#16a34a",
    ramp: ["#e2e8f0", "#bbf7d0", "#4ade80", "#16a34a", "#14532d"],
  },
  {
    key: "water",
    label: "Water",
    color: "#0ea5e9",
    ramp: ["#e2e8f0", "#bae6fd", "#38bdf8", "#0284c7", "#0c4a6e"],
  },
  {
    key: "architecture",
    label: "Architecture / historic",
    color: "#b45309",
    ramp: ["#e2e8f0", "#fde68a", "#f59e0b", "#b45309", "#78350f"],
  },
  {
    key: "art",
    label: "Art & landmarks",
    color: "#db2777",
    ramp: ["#e2e8f0", "#fbcfe8", "#f472b6", "#db2777", "#831843"],
  },
  {
    key: "quiet",
    label: "Quiet",
    color: "#6366f1",
    ramp: ["#e2e8f0", "#c7d2fe", "#818cf8", "#4f46e5", "#312e81"],
  },
  {
    key: "hills",
    label: "Hills & views",
    color: "#7c3aed",
    ramp: ["#e2e8f0", "#ddd6fe", "#a78bfa", "#7c3aed", "#4c1d95"],
  },
] as const;

/**
 * The composite view keeps a yellow→red heat ramp. It isn't any one axis, so
 * borrowing a hue would imply it was; heat reads as "how interesting overall"
 * without claiming a reason.
 */
export const OVERALL_RAMP = [
  "#e2e8f0",
  "#fed976",
  "#fd8d3c",
  "#f03b20",
  "#bd0026",
] as const;

/** Percentile positions the five ramp stops sit at. */
export const RAMP_STOPS = [0, 30, 55, 75, 100] as const;

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
 * Tag keys `FEATURE_SELECTORS` above actually asks Overpass for.
 *
 * Used to tell "this city is thin" apart from "we never looked", which §6
 * treats as different failures and which cannot be inferred from the data. Ask
 * for art deco and the extract yields four matches — not because NYC has four
 * art deco buildings, but because four buildings that matched some *other*
 * selector happen to carry `building:architecture` too. Reporting that as a
 * count would tell the user their city has no art deco, which is false.
 *
 * Keep in step with FEATURE_SELECTORS. Adding a key here without adding it
 * there turns an honest "not extracted" into a confidently wrong number.
 */
export const EXTRACTED_FEATURE_KEYS = new Set([
  "leisure",
  "landuse",
  "natural",
  "waterway",
  "man_made",
  "historic",
  "heritage",
  "tourism",
  "amenity",
  "building",
]);

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
  // for NYC, and it covers exactly what OSM misses. Held at the ceiling
  // deliberately: an LPC district is a judgement about a whole streetscape,
  // which is precisely the claim this axis wants to make.
  nyc_historic_districts: { axis: "architecture", weight: 1 },
  nys_historic_districts: { axis: "architecture", weight: 0.5 },
  // Well below the other two on purpose. The National Register lists individual
  // *buildings* far more often than coherent streetscapes, and in Midtown it
  // fires on office towers around the Garment District — which lit 8th Avenue
  // up at 0.48 architecture, nearly matching brownstone Park Slope. A listed
  // tower on a loud avenue is not the same claim as a designated district, and
  // because the axis is percentile-ranked, over-weighting the common case
  // compresses the whole distribution against the signal that matters.
  us_historic_places: { axis: "architecture", weight: 0.3 },
  // Designated for the view, which is the hills/views axis almost by definition.
  scenic_landmarks: { axis: "hills", weight: 0.9 },
};
