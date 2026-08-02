/**
 * The shape of the graph artifact written by `scripts/build-graph.ts`, plus the
 * edge-class vocabulary the debug map colours by.
 *
 * Nothing here touches the filesystem — the client bundle imports this too.
 * Disk access lives in `lib/graph-server.ts`.
 */

export type GraphMeta = {
  builtAt: string;
  source: string;
  nodes: number;
  edges: number;
  totalKm: number;
};

export type GraphEdge = {
  /** Index into `nodes` of the start junction. */
  a: number;
  /** Index into `nodes` of the end junction. */
  b: number;
  /** Metres. */
  len: number;
  /** Seconds on foot. */
  time: number;
  /** Index into `tagSets` — edges split from one way share a tag set. */
  t: number;
  /** Flat [lon, lat, lon, lat, ...]. */
  geom: number[];
};

export type GraphArtifact = {
  meta: GraphMeta;
  nodes: { lon: number[]; lat: number[] };
  tagSets: Record<string, string>[];
  edges: GraphEdge[];
};

/**
 * `highway` values collapsed into the few classes worth telling apart by eye.
 * Phase 0 asks one question — "is this the right network?" — and the answer is
 * mostly whether the big roads, the park paths and the sidewalks are where you
 * know them to be. Phase 1 replaces this colouring with the scenic score.
 *
 * Ordered loudest-road-first, which is also the order the legend reads in.
 */
export const EDGE_CLASSES = [
  { key: "primary", label: "Primary", color: "#dc2626" },
  { key: "secondary", label: "Secondary", color: "#ea580c" },
  { key: "tertiary", label: "Tertiary", color: "#ca8a04" },
  { key: "local", label: "Residential / service", color: "#64748b" },
  { key: "pedestrian", label: "Pedestrian / living street", color: "#0d9488" },
  { key: "path", label: "Footway / path", color: "#16a34a" },
  { key: "steps", label: "Steps", color: "#9333ea" },
  { key: "cycleway", label: "Cycleway / track", color: "#2563eb" },
  { key: "other", label: "Other", color: "#a1a1aa" },
] as const;

export type EdgeClass = (typeof EDGE_CLASSES)[number]["key"];

const CLASS_BY_HIGHWAY: Record<string, EdgeClass> = {
  primary: "primary",
  primary_link: "primary",
  secondary: "secondary",
  secondary_link: "secondary",
  tertiary: "tertiary",
  tertiary_link: "tertiary",
  residential: "local",
  service: "local",
  unclassified: "local",
  pedestrian: "pedestrian",
  living_street: "pedestrian",
  footway: "path",
  path: "path",
  steps: "steps",
  cycleway: "cycleway",
  track: "cycleway",
};

/** Total, by design — an unmapped `highway` value shows up as "other" rather than vanishing. */
export function edgeClass(tags: Record<string, string> | undefined): EdgeClass {
  return CLASS_BY_HIGHWAY[tags?.highway ?? ""] ?? "other";
}

export const CLASS_COLORS: Record<EdgeClass, string> = Object.fromEntries(
  EDGE_CLASSES.map((c) => [c.key, c.color]),
) as Record<EdgeClass, string>;

/** Per-class totals shown in the legend, so the map can be checked against numbers. */
export type ClassSummary = { key: EdgeClass; edges: number; km: number };
