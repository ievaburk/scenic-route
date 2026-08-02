/**
 * Server-side routing state: the CSR adjacency, and the per-edge scenic blend
 * a given set of user weights implies.
 *
 * Both are cached on globalThis for the same reason the graph is — building the
 * adjacency walks 170k edges, and doing it per request would dwarf the search
 * it exists to serve.
 */
import type { GraphArtifact } from "./graph";
import { AXIS_KEYS, DEFAULT_WEIGHTS, type ScenicAxis } from "./features";
import { compositeScore, type ScoreArtifact } from "./scoring";
import { buildRoutingGraph, makeScratch, type RoutingGraph, type SearchScratch } from "./router";
import { tryLoadGraph } from "./graph-server";
import { scoresFor } from "./scores-server";

const store = globalThis as typeof globalThis & {
  __scenicRouting?: { key: string; graph: RoutingGraph; scratch: SearchScratch };
  __scenicScenic?: { key: string; scenic: Float32Array };
};

export type RoutingContext = {
  graph: RoutingGraph;
  scratch: SearchScratch;
  artifact: GraphArtifact;
  scores: ScoreArtifact;
};

/** Null when either artifact is missing or they don't match each other. */
export function tryLoadRouting(): RoutingContext | null {
  const loaded = tryLoadGraph();
  if (!loaded) return null;

  const status = scoresFor(loaded);
  if (status.state !== "ok") return null;

  const key = loaded.graph.meta.builtAt;
  if (store.__scenicRouting?.key !== key) {
    const graph = buildRoutingGraph(loaded.graph);
    store.__scenicRouting = { key, graph, scratch: makeScratch(graph) };
  }

  return {
    graph: store.__scenicRouting.graph,
    scratch: store.__scenicRouting.scratch,
    artifact: loaded.graph,
    scores: status.scores,
  };
}

/**
 * Per-edge scenic value for a weight vector — the `scenic(e)` in
 * `time(e) · (1 − α · scenic(e))`.
 *
 * Uses the linear weighted mean from PLAN.md §8, deliberately *not* the
 * quadratic `overallScore` the debug map colours by. At route time the weights
 * belong to the user, so the axes they don't care about are already zeroed and
 * can't dilute the ones they do; the quadratic form exists only to answer
 * "interesting for any reason at all", which is a display question.
 *
 * Cached on the weight vector, since the α sweep re-reads this array ~24 times
 * per request.
 */
export function scenicFor(
  scores: ScoreArtifact,
  weights: Record<ScenicAxis, number> = DEFAULT_WEIGHTS,
): Float32Array {
  const key =
    scores.meta.builtAt + "|" + AXIS_KEYS.map((a) => weights[a] ?? 0).join(",");
  if (store.__scenicScenic?.key === key) return store.__scenicScenic.scenic;

  const n = scores.meta.edges;
  const scenic = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    scenic[i] = compositeScore(scores.axes, i, weights);
  }

  store.__scenicScenic = { key, scenic };
  return scenic;
}

/**
 * Nearest graph node to a lon/lat, by straight-line distance.
 *
 * Linear over 116k nodes, which is well under a millisecond and happens twice
 * per request. An index would be faster and is not yet worth the code.
 */
export function nearestNode(
  graph: RoutingGraph,
  artifact: GraphArtifact,
  lon: number,
  lat: number,
): number {
  // Compare in the projected metre space the graph already stores.
  const { lon: lons, lat: lats } = artifact.nodes;
  let best = -1;
  let bestD = Infinity;

  // Degrees are fine for *comparison* if we scale longitude by cos(lat) so the
  // two axes are commensurate — picking the wrong nearest node by a metre is
  // invisible, but picking one a block away because longitude was untreated is
  // not.
  const lonScale = Math.cos((lat * Math.PI) / 180);

  for (let n = 0; n < lons.length; n++) {
    const dx = (lons[n] - lon) * lonScale;
    const dy = lats[n] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}
