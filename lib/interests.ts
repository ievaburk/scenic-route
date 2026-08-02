/**
 * Free-text interests: phrase → OSM tag filter (PLAN.md §6).
 *
 * The six axes are a starting vocabulary, not the ceiling. Someone obsessed
 * with bridges, cobblestones or statues should be able to type that and have it
 * genuinely change their routes — and OSM's tag vocabulary is far richer than
 * six numbers, which is exactly why `build-graph.ts` keeps the full raw tag set
 * on every edge.
 *
 * Two rules govern everything here.
 *
 * **Every entry is grounded in a count from the actual pilot extract.** The
 * counts in the comments below were measured, not guessed. §6 is blunt that
 * verifying against the real graph "is what stops the feature being a lie", and
 * a dictionary written from imagination is precisely that lie — it would
 * confidently accept "art nouveau" and then quietly do nothing.
 *
 * **Filters are data, never code.** Keys are checked against `ALLOWED_KEYS`
 * before a filter is built. That matters little for this hand-written
 * dictionary and enormously for the LLM fallback §6 adds later, where a user's
 * phrase reaches a model whose output becomes a query — §11's eighth hard part.
 * The schema is deliberately too weak to express anything but a conjunction of
 * key/value tests.
 */

/** One test against a tag set: key present, or key with one of these values. */
export type TagClause = {
  key: string;
  /** Omit to match the key's mere presence. */
  values?: string[];
  /** Values that disqualify a match even when `values` matches. */
  not?: string[];
};

export type TagFilter = {
  /** Tested against the edge's own OSM tags — bridges, surfaces, steps. */
  edge?: TagClause[];
  /** Tested against nearby scenic features — statues, fountains, museums. */
  feature?: TagClause[];
  /** Metres a matching feature's influence carries. Ignored for edge clauses. */
  reach?: number;
};

/**
 * Tag keys a filter may reference.
 *
 * The whitelist is the security boundary for the LLM fallback: a generated
 * filter naming any other key is rejected outright rather than sanitised.
 * Keeping it explicit also documents what the resolver can actually see.
 */
export const ALLOWED_KEYS = [
  // Edge-side
  "highway", "surface", "bridge", "tunnel", "covered", "lit", "incline",
  "step_count", "handrail", "width", "wikidata", "wikipedia", "historic",
  "man_made", "waterway", "footway", "wheelchair", "smoothness", "tracktype",
  // Feature-side
  "tourism", "amenity", "leisure", "natural", "landuse", "building",
  "artwork_type", "memorial", "heritage", "religion", "shop", "craft",
  "building:architecture", "architect", "start_date",
] as const;

export type AllowedKey = (typeof ALLOWED_KEYS)[number];

const ALLOWED = new Set<string>(ALLOWED_KEYS);

/** Rejects a filter naming any key outside the whitelist. */
export function validateFilter(filter: TagFilter): { ok: true } | { ok: false; reason: string } {
  for (const side of [filter.edge, filter.feature]) {
    for (const clause of side ?? []) {
      if (!ALLOWED.has(clause.key)) {
        return { ok: false, reason: `tag key "${clause.key}" is not allowed` };
      }
      if (clause.values && clause.values.length === 0) {
        return { ok: false, reason: `empty value list for "${clause.key}"` };
      }
    }
  }
  if (!filter.edge?.length && !filter.feature?.length) {
    return { ok: false, reason: "filter matches nothing" };
  }
  return { ok: true };
}

export type InterestEntry = {
  /** Canonical id, also the cache key for the computed layer. */
  id: string;
  label: string;
  /** Everything a user might plausibly type for this. Normalised on lookup. */
  synonyms: string[];
  filter: TagFilter;
  /**
   * Told to the user when the match count is low, so a thin result reads as a
   * limitation of the data rather than a broken feature (§6).
   */
  caveat?: string;
  /**
   * Set when answering this honestly needs an extraction we haven't run, so any
   * count we could produce would be an artefact rather than an answer.
   *
   * A curator's judgement on purpose. The automatic check — "is this key
   * present on enough fetched features?" — can't separate the two cases here:
   * `building:architecture` rides along on 32 buildings that matched *other*
   * selectors, which clears any sensible threshold, yet the 4 art deco hits
   * among them say nothing about the hundreds in the city. Reporting "4" would
   * tell the user NYC has almost no art deco. Adding the key to
   * FEATURE_SELECTORS and re-fetching is what actually fixes it.
   */
  requiresFetch?: true;
};

/**
 * The curated dictionary.
 *
 * Counts are from the pilot extract (Manhattan below 125th + brownstone
 * Brooklyn), measured 2026-08-02. §6 wants ~150 entries eventually; these are
 * the ones the current extract can actually answer, which is the honest place
 * to start. New entries should be added only alongside a measured count.
 */
export const DICTIONARY: InterestEntry[] = [
  {
    id: "bridges",
    label: "Bridges",
    synonyms: ["bridge", "bridges", "viaduct", "viaducts", "overpass", "crossings"],
    // 677 edges tagged bridge=yes, 30.2 km — plus 221 man_made=bridge features.
    filter: {
      edge: [{ key: "bridge", not: ["no"] }],
      feature: [{ key: "man_made", values: ["bridge"] }],
      reach: 80,
    },
  },
  {
    id: "tunnels",
    label: "Tunnels",
    synonyms: ["tunnel", "tunnels", "underpass", "underpasses", "subway tunnel"],
    // 262 edges tagged tunnel=yes, 7.9 km.
    filter: { edge: [{ key: "tunnel", not: ["no"] }] },
  },
  {
    id: "cobblestones",
    label: "Cobblestone streets",
    synonyms: [
      "cobblestone", "cobblestones", "cobbled", "cobbles", "setts",
      "belgian block", "old streets", "historic paving",
    ],
    /**
     * `sett` only, deliberately — 947 edges, 25.9 km. §6 suggests including
     * `paving_stones`, but that's 8,083 edges of modern precast pavers in the
     * pilot area: eight times as many as the real thing, and nobody typing
     * "cobblestones" means a plaza outside an office block. Including it would
     * dilute the interest into noise.
     */
    filter: { edge: [{ key: "surface", values: ["sett", "cobblestone"] }] },
  },
  {
    id: "stairs",
    label: "Stairs & steps",
    synonyms: ["stairs", "steps", "staircase", "staircases", "stepped streets"],
    // 2,125 edges, 14.9 km.
    filter: { edge: [{ key: "highway", values: ["steps"] }] },
  },
  {
    id: "statues",
    label: "Statues & sculpture",
    synonyms: [
      "statue", "statues", "sculpture", "sculptures", "public art", "monuments",
    ],
    // 220 sculpture + 169 statue + 51 monument features.
    filter: {
      feature: [
        { key: "artwork_type", values: ["statue", "sculpture", "bust"] },
        { key: "historic", values: ["monument", "memorial"] },
        { key: "memorial", values: ["statue", "bust"] },
      ],
      reach: 60,
    },
  },
  {
    id: "murals",
    label: "Murals & street art",
    synonyms: ["mural", "murals", "street art", "graffiti", "wall art"],
    // 51 mural features — thin, and worth saying so.
    filter: { feature: [{ key: "artwork_type", values: ["mural", "graffiti"] }], reach: 50 },
    caveat: "Murals are patchily mapped in OSM — expect this to nudge routes rather than shape them.",
  },
  {
    id: "fountains",
    label: "Fountains",
    synonyms: ["fountain", "fountains", "water feature"],
    // 191 features.
    filter: { feature: [{ key: "amenity", values: ["fountain"] }], reach: 50 },
  },
  {
    id: "museums",
    label: "Museums & galleries",
    synonyms: ["museum", "museums", "gallery", "galleries", "art galleries"],
    // 104 museums + 311 galleries.
    filter: { feature: [{ key: "tourism", values: ["museum", "gallery"] }], reach: 60 },
  },
  {
    id: "churches",
    label: "Churches & places of worship",
    synonyms: [
      "church", "churches", "cathedral", "cathedrals", "synagogue", "synagogues",
      "mosque", "temple", "places of worship", "religious buildings",
    ],
    // 316 building=church + 843 amenity=place_of_worship.
    filter: {
      feature: [
        { key: "building", values: ["church", "cathedral", "chapel", "synagogue", "mosque", "temple"] },
        { key: "amenity", values: ["place_of_worship"] },
      ],
      reach: 60,
    },
  },
  {
    id: "viewpoints",
    label: "Viewpoints",
    synonyms: ["viewpoint", "viewpoints", "views", "lookout", "overlook", "vista", "skyline"],
    // 80 features.
    filter: { feature: [{ key: "tourism", values: ["viewpoint"] }], reach: 150 },
  },
  {
    id: "piers",
    label: "Piers & waterfront",
    synonyms: ["pier", "piers", "wharf", "docks", "waterfront", "boardwalk", "quay"],
    // 417 man_made=pier features.
    filter: { feature: [{ key: "man_made", values: ["pier"] }], reach: 120 },
  },
  {
    id: "plaques",
    label: "Historic plaques",
    synonyms: ["plaque", "plaques", "blue plaques", "historical markers", "markers"],
    // 99 features.
    filter: { feature: [{ key: "memorial", values: ["plaque", "stone"] }], reach: 40 },
    caveat: "Plaques are sparsely mapped — this will shift routes only slightly.",
  },
  {
    id: "arcades",
    label: "Covered walkways",
    synonyms: ["arcade", "arcades", "covered", "colonnade", "shelter", "under cover"],
    // 889 edges tagged covered.
    filter: { edge: [{ key: "covered", not: ["no"] }] },
  },
  {
    id: "lit-streets",
    label: "Well-lit streets",
    synonyms: ["lit", "well lit", "lighting", "streetlights", "street lamps", "night safety"],
    /**
     * 28,485 edges. Not scenery — this is the counterweight §11 requires before
     * night routing ships, since maximising `quiet` after dark is maximising
     * "nobody around". Exposed as an interest so it can be tested now.
     */
    filter: { edge: [{ key: "lit", values: ["yes", "24/7"] }] },
  },
  {
    id: "step-free",
    label: "Step-free routes",
    synonyms: ["step free", "stepfree", "accessible", "wheelchair", "no stairs", "level"],
    // 276 edges wheelchair=yes. Inverse handling belongs in routing, not here.
    filter: { edge: [{ key: "wheelchair", values: ["yes", "designated"] }] },
    caveat: "Only explicitly-tagged edges count; untagged does not mean inaccessible.",
  },
  {
    id: "notable-streets",
    label: "Streets with a story",
    synonyms: [
      "famous streets", "historic streets", "notable", "streets with history",
      "wikipedia", "landmarks",
    ],
    /**
     * 15,178 edges carry `wikidata` and 14,382 `wikipedia` — a mapper thought
     * the street itself worth an encyclopaedia entry. Broad, but a real signal
     * and one no curated list would have produced.
     */
    filter: { edge: [{ key: "wikipedia" }, { key: "wikidata" }] },
  },
  {
    id: "art-deco",
    label: "Art deco",
    synonyms: ["art deco", "deco", "1930s architecture", "jazz age"],
    /**
     * Resolves to a real filter, but `building:architecture` was never part of
     * the scenic-feature extract, so the pilot data cannot answer it today.
     * Kept deliberately: the resolver reports "not extracted" rather than
     * "0 matches", which is the difference between an honest limitation and a
     * silent lie. Adding the key to FEATURE_SELECTORS and re-fetching fixes it.
     */
    filter: {
      feature: [{ key: "building:architecture", values: ["art_deco"] }],
      reach: 50,
    },
    requiresFetch: true,
  },
  {
    id: "bookshops",
    label: "Bookshops",
    synonyms: ["bookshop", "bookshops", "bookstore", "bookstores", "second hand books", "books"],
    // Same as art deco: valid filter, `shop` not in the current extract.
    filter: { feature: [{ key: "shop", values: ["books"] }], reach: 40 },
    requiresFetch: true,
  },
];

/**
 * Normalise a typed phrase for lookup.
 *
 * Deliberately crude — lowercase, strip punctuation, collapse whitespace, drop
 * a leading article, and singularise a trailing "s". A real stemmer would buy
 * very little here: the dictionary carries explicit plural synonyms, and §6's
 * plan for the long tail is an LLM call rather than better string munging.
 */
export function normalisePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(the|a|an|some|any)\s+/, "");
}

/** Lookup index over ids and synonyms, both raw and singularised. */
const INDEX = new Map<string, InterestEntry>();
for (const entry of DICTIONARY) {
  for (const term of [entry.id, entry.label, ...entry.synonyms]) {
    const key = normalisePhrase(term);
    if (key) INDEX.set(key, entry);
    const singular = key.replace(/s$/, "");
    if (singular && !INDEX.has(singular)) INDEX.set(singular, entry);
  }
}

export type Resolution =
  | { status: "resolved"; entry: InterestEntry; phrase: string; via: "dictionary" }
  | { status: "unresolved"; phrase: string };

/**
 * Phrase → dictionary entry.
 *
 * Dictionary only for now; §6's LLM fallback slots in here, behind
 * `validateFilter`, and its results should promote into `DICTIONARY` so the
 * asset compounds. Unresolved phrases are worth logging — §6 calls that ranked
 * list "the cheapest product research in the plan".
 */
export function resolveInterest(phrase: string): Resolution {
  const normalised = normalisePhrase(phrase);
  if (!normalised) return { status: "unresolved", phrase };

  const direct = INDEX.get(normalised) ?? INDEX.get(normalised.replace(/s$/, ""));
  if (direct) {
    return { status: "resolved", entry: direct, phrase: normalised, via: "dictionary" };
  }

  // A typed phrase often contains the term rather than being it — "i like
  // bridges", "cobblestone streets in brooklyn".
  for (const [term, entry] of INDEX) {
    if (term.length >= 4 && normalised.includes(term)) {
      return { status: "resolved", entry, phrase: normalised, via: "dictionary" };
    }
  }

  return { status: "unresolved", phrase: normalised };
}

/** Does a tag set satisfy every clause? Clauses are OR'd within a side. */
export function matchesAny(
  tags: Record<string, string>,
  clauses: TagClause[],
): boolean {
  for (const clause of clauses) {
    const value = tags[clause.key];
    if (value === undefined) continue;
    if (clause.not?.includes(value)) continue;
    if (!clause.values || clause.values.includes(value)) return true;
  }
  return false;
}

/** MVP cap from PLAN.md §6 — more than this and each one is diluted below notice. */
export const MAX_INTERESTS = 5;
