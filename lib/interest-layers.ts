/**
 * Sparse per-interest edge layers (PLAN.md §6).
 *
 * The six core axes are dense — every edge has a score, precomputed. Custom
 * interests can't work that way: they're per-user and unbounded. Each resolved
 * interest instead gets its own **sparse** edge → score map, computed once and
 * cached globally by interest id, because "bridges in NYC" is the same answer
 * for every user who ever asks. At route time most edges miss every sparse map,
 * so it's a handful of hash misses per edge and the hot loop stays fast.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import RBush from "rbush";
import { projector } from "./geo";
import { PILOT } from "./pilot";
import { decay } from "./scoring";
import { EXTRACTED_FEATURE_KEYS } from "./features";
import { matchesAny, type InterestEntry, type TagClause } from "./interests";
import type { GraphArtifact } from "./graph";

const RAW_DIR = path.join(process.cwd(), "data", "raw");

/** Below this many matches, say so rather than pretending it will shape a walk. */
const THIN_THRESHOLD = 25;

/** Reach when a filter doesn't specify one. */
const DEFAULT_REACH = 60;

export type Coverage =
  /** Enough matches to actually shape a route. */
  | "ok"
  /** Resolves, matches, but the city has too few for it to matter much. */
  | "thin"
  /**
   * The filter is valid but names a tag key absent from the extract entirely —
   * so we genuinely don't know. Reporting this as "0 matches" would be the lie
   * §6 warns about: the user would read "your city has no art deco" when the
   * truth is "we never asked Overpass for it".
   */
  | "not-extracted";

export type InterestLayer = {
  id: string;
  label: string;
  /** Sparse edge index → 0–1. Absent means zero. */
  scores: Map<number, number>;
  /** Things matched: edges for edge filters, features for feature filters. */
  matchCount: number;
  coverage: Coverage;
  caveat?: string;
};

type FeaturePoint = { tags: Record<string, string>; x: number; y: number };
type Indexed = { minX: number; minY: number; maxX: number; maxY: number; i: number };

const store = globalThis as typeof globalThis & {
  __scenicFeatures?: { points: FeaturePoint[]; keyCounts: Map<string, number> };
  __scenicInterestLayers?: Map<string, InterestLayer>;
};

/**
 * Every scenic feature as a single representative point, plus the set of tag
 * keys the extract contains at all.
 *
 * A representative point rather than full geometry: interests are point-like
 * (a statue, a fountain, a bookshop) and their reach is 40–150 m, so the
 * centroid-ish error on a way is immaterial. The dense axes in
 * `score-graph.ts` do use real geometry, because "inside a park" genuinely
 * depends on it.
 *
 * The key set is what makes `not-extracted` detectable.
 */
function loadFeatures(): { points: FeaturePoint[]; keyCounts: Map<string, number> } {
  if (store.__scenicFeatures) return store.__scenicFeatures;

  const proj = projector(PILOT.bbox.west, PILOT.bbox.south);
  const points: FeaturePoint[] = [];
  const keyCounts = new Map<string, number>();
  const seen = new Set<string>();

  const files = existsSync(RAW_DIR)
    ? readdirSync(RAW_DIR).filter((f) => f.startsWith("feat_") && f.endsWith(".json"))
    : [];

  for (const file of files) {
    const raw = JSON.parse(readFileSync(path.join(RAW_DIR, file), "utf8")) as {
      elements: {
        type: string;
        id: number;
        tags?: Record<string, string>;
        lat?: number;
        lon?: number;
        geometry?: { lat: number; lon: number }[];
        members?: { geometry?: { lat: number; lon: number }[] }[];
      }[];
    };

    for (const el of raw.elements) {
      const key = `${el.type}/${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!el.tags) continue;

      for (const k of Object.keys(el.tags)) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);

      let lon: number | undefined;
      let lat: number | undefined;
      if (el.lat !== undefined && el.lon !== undefined) {
        lon = el.lon;
        lat = el.lat;
      } else if (el.geometry?.length) {
        const mid = el.geometry[Math.floor(el.geometry.length / 2)];
        lon = mid.lon;
        lat = mid.lat;
      } else if (el.members?.length) {
        const g = el.members.find((m) => m.geometry?.length)?.geometry;
        if (g?.length) {
          lon = g[Math.floor(g.length / 2)].lon;
          lat = g[Math.floor(g.length / 2)].lat;
        }
      }
      if (lon === undefined || lat === undefined) continue;

      points.push({ tags: el.tags, x: proj.x(lon), y: proj.y(lat) });
    }
  }

  store.__scenicFeatures = { points, keyCounts };
  return store.__scenicFeatures;
}

/**
 * True when no clause names a key the extract actually queried for.
 *
 * Deliberately checks what was *asked for*, not what happens to be present.
 * `building:architecture` turns up on four features in the pilot extract —
 * buildings that matched some other selector and carry the tag incidentally —
 * so a presence test would call art deco "thin" and report 4. NYC has hundreds.
 * The user would read that as "your city has no art deco" when the truth is
 * "we never asked Overpass for it", which is the failure §6 is most concerned
 * about.
 */
function keysNotExtracted(
  clauses: TagClause[],
  keyCounts: Map<string, number>,
): boolean {
  if (clauses.length === 0) return false;
  return clauses.every((c) => {
    // Queried directly — whatever the count, it's the real answer.
    if (EXTRACTED_FEATURE_KEYS.has(c.key)) return false;
    // Not queried, but riding along on features that were: `artwork_type`
    // appears on 528 fetched artworks, so "murals" is a genuine, if sparse,
    // answer. `building:architecture` appears on 4, which is noise.
    return (keyCounts.get(c.key) ?? 0) < THIN_THRESHOLD;
  });
}

/**
 * Compute (or fetch from cache) the sparse layer for one interest.
 *
 * Edge clauses score a flat 1 — the edge *is* the bridge, there's no distance
 * to decay. Feature clauses decay with distance from the edge's midpoint, the
 * same shape the dense axes use.
 */
export function interestLayer(
  entry: InterestEntry,
  artifact: GraphArtifact,
): InterestLayer {
  const cache = (store.__scenicInterestLayers ??= new Map());
  const cached = cache.get(entry.id);
  if (cached) return cached;

  const scores = new Map<number, number>();
  let matchCount = 0;
  let coverage: Coverage = "ok";

  // Curator has flagged this as needing an extraction we haven't run, so any
  // count would be an artefact. Say we don't know rather than inventing one.
  if (entry.requiresFetch) {
    const empty: InterestLayer = {
      id: entry.id, label: entry.label, scores, matchCount: 0,
      coverage: "not-extracted", caveat: entry.caveat,
    };
    cache.set(entry.id, empty);
    return empty;
  }

  // ---- edge-tag side ----
  if (entry.filter.edge?.length) {
    const matchingTagSets = new Set<number>();
    for (let t = 0; t < artifact.tagSets.length; t++) {
      if (matchesAny(artifact.tagSets[t], entry.filter.edge)) matchingTagSets.add(t);
    }
    for (let i = 0; i < artifact.edges.length; i++) {
      if (matchingTagSets.has(artifact.edges[i].t)) {
        scores.set(i, 1);
        matchCount++;
      }
    }
  }

  // ---- feature-proximity side ----
  if (entry.filter.feature?.length) {
    const { points, keyCounts } = loadFeatures();

    if (keysNotExtracted(entry.filter.feature, keyCounts)) {
      coverage = "not-extracted";
    } else {
      const reach = entry.filter.reach ?? DEFAULT_REACH;
      const items: Indexed[] = [];
      for (let i = 0; i < points.length; i++) {
        if (!matchesAny(points[i].tags, entry.filter.feature)) continue;
        matchCount++;
        items.push({
          minX: points[i].x - reach,
          minY: points[i].y - reach,
          maxX: points[i].x + reach,
          maxY: points[i].y + reach,
          i,
        });
      }

      if (items.length > 0) {
        const tree = new RBush<Indexed>();
        tree.load(items);
        const proj = projector(PILOT.bbox.west, PILOT.bbox.south);

        for (let e = 0; e < artifact.edges.length; e++) {
          const geom = artifact.edges[e].geom;
          // Midpoint vertex is enough at these reaches; the dense pipeline
          // samples every 25 m because parks are large and interests aren't.
          const m = Math.floor(geom.length / 4) * 2;
          const px = proj.x(geom[m]);
          const py = proj.y(geom[m + 1]);

          let best = 0;
          for (const hit of tree.search({ minX: px, minY: py, maxX: px, maxY: py })) {
            const p = points[hit.i];
            const d = Math.hypot(px - p.x, py - p.y);
            if (d < reach) {
              const v = decay(d, reach);
              if (v > best) best = v;
            }
          }
          if (best > 0) scores.set(e, Math.max(scores.get(e) ?? 0, best));
        }
      }
    }
  }

  if (coverage === "ok" && matchCount < THIN_THRESHOLD) coverage = "thin";

  const layer: InterestLayer = {
    id: entry.id,
    label: entry.label,
    scores,
    matchCount,
    coverage,
    caveat: entry.caveat,
  };
  cache.set(entry.id, layer);
  return layer;
}

/**
 * Fold interest layers into a scenic array, in place.
 *
 * `scenic(e) = Σ core_axes + Σ sparse_lookups` (§6). Interests *add* to the
 * core score rather than replacing it, so asking for bridges doesn't turn off
 * everything else that makes a walk good — and the result is clamped, because
 * α needs `scenic ∈ [0,1]` for edge costs to stay non-negative.
 */
export function applyInterests(
  scenic: Float32Array,
  layers: { layer: InterestLayer; weight: number }[],
): Float32Array {
  if (layers.length === 0) return scenic;

  const out = new Float32Array(scenic);
  for (const { layer, weight } of layers) {
    if (weight === 0) continue;
    for (const [edge, value] of layer.scores) {
      out[edge] = Math.min(1, out[edge] + weight * value);
    }
  }
  return out;
}
