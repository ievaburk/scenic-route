/**
 * Server-side access to the graph artifact.
 *
 * The artifact is 31 MB of JSON and every route request is pure CPU against
 * it, so it is parsed once into a module-level singleton (PLAN.md §7). Reading
 * it per request would dominate every timing measurement we later care about.
 *
 * `data/graph.json` is gitignored and rebuildable, so "not built yet" is a
 * normal state, not an error — hence `tryLoadGraph()` returning null rather
 * than throwing.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  EDGE_CLASSES,
  edgeClass,
  type ClassSummary,
  type EdgeClass,
  type GraphArtifact,
} from "./graph";
import { AXIS_KEYS, DEFAULT_WEIGHTS, type ScenicAxis } from "./features";
import { overallScore, type ScoreArtifact } from "./scoring";

export const GRAPH_FILE = path.join(process.cwd(), "data", "graph.json");

export type LoadedGraph = {
  graph: GraphArtifact;
  /** Class per tag-set index — 78k tag sets versus 170k edges, so resolve it once here. */
  classOfTagSet: EdgeClass[];
  summary: ClassSummary[];
  /** Changes when the graph is rebuilt, which is exactly when clients must refetch. */
  etag: string;
};

/**
 * Dev HMR throws away module state on every edit. Parking the cache on
 * globalThis keeps a 31 MB re-parse from happening on each save.
 */
const store = globalThis as typeof globalThis & {
  __scenicGraph?: LoadedGraph;
  /** Keyed, because the payload differs depending on whether scores exist yet. */
  __scenicGraphGeoJSON?: { key: string; json: string };
};

export function tryLoadGraph(): LoadedGraph | null {
  if (store.__scenicGraph) return store.__scenicGraph;
  if (!existsSync(GRAPH_FILE)) return null;

  const graph = JSON.parse(readFileSync(GRAPH_FILE, "utf8")) as GraphArtifact;

  const classOfTagSet = graph.tagSets.map((tags) => edgeClass(tags));

  const edgesPerClass = new Map<EdgeClass, number>();
  const metresPerClass = new Map<EdgeClass, number>();
  for (const e of graph.edges) {
    const k = classOfTagSet[e.t];
    edgesPerClass.set(k, (edgesPerClass.get(k) ?? 0) + 1);
    metresPerClass.set(k, (metresPerClass.get(k) ?? 0) + e.len);
  }

  const summary: ClassSummary[] = EDGE_CLASSES.map((c) => ({
    key: c.key,
    edges: edgesPerClass.get(c.key) ?? 0,
    km: Math.round((metresPerClass.get(c.key) ?? 0) / 100) / 10,
  })).filter((c) => c.edges > 0);

  const loaded: LoadedGraph = {
    graph,
    classOfTagSet,
    summary,
    etag: `W/"${graph.meta.builtAt}-${graph.meta.edges}"`,
  };
  store.__scenicGraph = loaded;
  return loaded;
}

/**
 * The whole walkable network as one GeoJSON FeatureCollection, built as a
 * string rather than an object: MapLibre takes a URL and parses it in a worker,
 * so nothing is gained by materialising 170k feature objects on the server.
 *
 * Properties are abbreviated on purpose — at 170k features, a longer name costs
 * megabytes. `i` edge index, `c` class, `l` metres, `s` seconds on foot, `t`
 * tag-set index (fetched on click via /api/debug/tags/[i]).
 *
 * When scores are available each edge also carries `sc` (composite) and one key
 * per axis — `gr wa ar la qu hi`. Two compressions matter at this scale:
 * scores go over the wire as **integers 0–100** rather than floats, and **zeros
 * are omitted entirely**. Most edges have no water, art or hills anywhere near
 * them, so omission alone removes several megabytes. The client reads them back
 * with a `coalesce` to 0.
 */
const AXIS_PROPERTY: Record<ScenicAxis, string> = {
  green: "gr",
  water: "wa",
  architecture: "ar",
  art: "la",
  quiet: "qu",
  hills: "hi",
};

export function graphGeoJSON(
  loaded: LoadedGraph,
  scores: ScoreArtifact | null,
): string {
  const key = scores ? scores.meta.builtAt : "none";
  if (store.__scenicGraphGeoJSON?.key === key) {
    return store.__scenicGraphGeoJSON.json;
  }

  const { graph, classOfTagSet } = loaded;
  const features = new Array<string>(graph.edges.length);

  for (let i = 0; i < graph.edges.length; i++) {
    const e = graph.edges[i];
    const coords = new Array<string>(e.geom.length / 2);
    for (let j = 0, c = 0; j < e.geom.length; j += 2, c++) {
      coords[c] = `[${e.geom[j]},${e.geom[j + 1]}]`;
    }

    let scoreProps = "";
    if (scores) {
      for (const axis of AXIS_KEYS) {
        const v = Math.round((scores.axes[axis][i] ?? 0) * 100);
        if (v > 0) scoreProps += `,"${AXIS_PROPERTY[axis]}":${v}`;
      }
      const overall = Math.round(
        overallScore(scores.axes, i, DEFAULT_WEIGHTS) * 100,
      );
      if (overall > 0) scoreProps += `,"sc":${overall}`;
    }

    features[i] =
      `{"type":"Feature","properties":{"i":${i},"c":"${classOfTagSet[e.t]}",` +
      `"l":${e.len},"s":${e.time},"t":${e.t}${scoreProps}},` +
      `"geometry":{"type":"LineString","coordinates":[${coords.join(",")}]}}`;
  }

  const json = `{"type":"FeatureCollection","features":[${features.join(",")}]}`;
  store.__scenicGraphGeoJSON = { key, json };
  return json;
}
