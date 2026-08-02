/**
 * Turn the cached Overpass tiles into a routable walking graph.
 *
 * The important, non-obvious decision here: every edge keeps its FULL raw OSM
 * tag set (deduplicated across edges that came from the same way). The six
 * scenic axes are only a starting vocabulary — free-text interests later need
 * to ask questions like "is this edge a bridge / cobbled / art deco", and you
 * cannot answer those against a graph that only stored six numbers.
 *
 *   npm run build:graph
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { polylineLengthM } from "../lib/geo";
import { STAIRS_SPEED_MPS, WALK_SPEED_MPS } from "../lib/pilot";

const RAW_DIR = path.join(process.cwd(), "data", "raw");
const OUT_FILE = path.join(process.cwd(), "data", "graph.json");

type OsmNode = { type: "node"; id: number; lat: number; lon: number };
type OsmWay = {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
};
type OsmElement = OsmNode | OsmWay;

/** Access tags that positively grant foot access even on a restricted way. */
const FOOT_ALLOWED = new Set(["yes", "designated", "permissive", "destination"]);

/**
 * Can a pedestrian plausibly walk this way? Errs toward including things —
 * a missing tag in OSM means "unknown", not "forbidden".
 */
function isWalkable(tags: Record<string, string> | undefined): boolean {
  if (!tags?.highway) return false;

  // Polygonal pedestrian areas (squares, plazas) are not linear features.
  // Routing across them properly needs a different treatment; skip for now.
  if (tags.area === "yes") return false;

  const foot = tags.foot;
  if (foot === "no" || foot === "private") return false;

  if (!FOOT_ALLOWED.has(foot ?? "")) {
    const access = tags.access;
    if (access === "no" || access === "private") return false;
  }

  // Bike paths are only walkable when they say so.
  if (tags.highway === "cycleway" && !FOOT_ALLOWED.has(foot ?? "")) return false;

  // Parking aisles and driveways technically connect, but they flood the graph
  // with noise and nobody chooses to walk down them.
  if (
    tags.highway === "service" &&
    (tags.service === "parking_aisle" || tags.service === "driveway")
  ) {
    return false;
  }

  return true;
}

function speedFor(tags: Record<string, string>): number {
  return tags.highway === "steps" ? STAIRS_SPEED_MPS : WALK_SPEED_MPS;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

async function main() {
  const files = (await readdir(RAW_DIR)).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    throw new Error(`No tiles in ${RAW_DIR}. Run \`npm run fetch:osm\` first.`);
  }

  // ---- 1. Load and dedupe raw elements across overlapping tiles -----------
  const nodeLon = new Map<number, number>();
  const nodeLat = new Map<number, number>();
  const ways = new Map<number, OsmWay>();

  for (const f of files) {
    const raw = JSON.parse(
      await readFile(path.join(RAW_DIR, f), "utf8"),
    ) as { elements: OsmElement[] };

    for (const el of raw.elements) {
      if (el.type === "node") {
        nodeLon.set(el.id, el.lon);
        nodeLat.set(el.id, el.lat);
      } else if (el.type === "way" && !ways.has(el.id)) {
        ways.set(el.id, el);
      }
    }
  }
  console.log(
    `${files.length} tiles → ${ways.size} ways, ${nodeLon.size} nodes`,
  );

  // ---- 2. Keep only ways a pedestrian can use ----------------------------
  const kept: OsmWay[] = [];
  for (const w of ways.values()) {
    if (isWalkable(w.tags) && w.nodes.length >= 2) kept.push(w);
  }
  console.log(`${kept.length} walkable ways`);

  // ---- 3. Find junctions: any node shared by 2+ ways, plus way endpoints --
  const refCount = new Map<number, number>();
  for (const w of kept) {
    for (const n of w.nodes) refCount.set(n, (refCount.get(n) ?? 0) + 1);
  }

  const isJunction = (id: number) => (refCount.get(id) ?? 0) >= 2;

  // ---- 4. Split each way into edges between junctions ---------------------
  type RawEdge = { a: number; b: number; refs: number[]; wayId: number };
  const rawEdges: RawEdge[] = [];
  let skippedMissingCoords = 0;

  for (const w of kept) {
    // Drop ways with any node we somehow lack coordinates for.
    if (w.nodes.some((n) => !nodeLon.has(n))) {
      skippedMissingCoords++;
      continue;
    }

    let run: number[] = [w.nodes[0]];
    for (let i = 1; i < w.nodes.length; i++) {
      const n = w.nodes[i];
      run.push(n);
      const last = i === w.nodes.length - 1;
      if (isJunction(n) || last) {
        if (run.length >= 2 && run[0] !== run[run.length - 1]) {
          rawEdges.push({
            a: run[0],
            b: run[run.length - 1],
            refs: run,
            wayId: w.id,
          });
        }
        run = [n];
      }
    }
  }
  if (skippedMissingCoords > 0) {
    console.log(`${skippedMissingCoords} ways skipped (missing node coords)`);
  }
  console.log(`${rawEdges.length} edges before pruning`);

  // ---- 5. Keep the largest connected component ---------------------------
  // Disconnected islands are almost always mapping artefacts or fragments
  // clipped at the pilot boundary. Routing into them fails, so drop them.
  const adj = new Map<number, number[]>();
  for (const [i, e] of rawEdges.entries()) {
    (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(i);
    (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push(i);
  }

  const seen = new Set<number>();
  let best: Set<number> = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp = new Set<number>();
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const n = stack.pop()!;
      comp.add(n);
      for (const ei of adj.get(n) ?? []) {
        const e = rawEdges[ei];
        for (const other of [e.a, e.b]) {
          if (!seen.has(other)) {
            seen.add(other);
            stack.push(other);
          }
        }
      }
    }
    if (comp.size > best.size) best = comp;
  }
  console.log(
    `largest component: ${best.size} of ${adj.size} junction nodes ` +
      `(${((best.size / adj.size) * 100).toFixed(1)}%)`,
  );

  // ---- 6. Compact indices, deduped tag sets, flat geometry ---------------
  const nodeIndex = new Map<number, number>();
  const lons: number[] = [];
  const lats: number[] = [];
  const indexOf = (osmId: number) => {
    let i = nodeIndex.get(osmId);
    if (i === undefined) {
      i = lons.length;
      nodeIndex.set(osmId, i);
      lons.push(r6(nodeLon.get(osmId)!));
      lats.push(r6(nodeLat.get(osmId)!));
    }
    return i;
  };

  // Edges split from one way share a tag set; storing it once per way keeps
  // the artifact from tripling in size.
  const tagSets: Record<string, string>[] = [];
  const tagSetIndex = new Map<number, number>();
  const tagIndexFor = (wayId: number) => {
    let i = tagSetIndex.get(wayId);
    if (i === undefined) {
      i = tagSets.length;
      tagSetIndex.set(wayId, i);
      tagSets.push(ways.get(wayId)!.tags ?? {});
    }
    return i;
  };

  const edges: {
    a: number;
    b: number;
    len: number;
    time: number;
    t: number;
    geom: number[];
  }[] = [];

  let totalM = 0;
  for (const e of rawEdges) {
    if (!best.has(e.a)) continue;

    const geom: number[] = [];
    for (const n of e.refs) {
      geom.push(r6(nodeLon.get(n)!), r6(nodeLat.get(n)!));
    }
    const len = polylineLengthM(geom);
    if (len === 0) continue;

    const tags = ways.get(e.wayId)!.tags ?? {};
    totalM += len;
    edges.push({
      a: indexOf(e.a),
      b: indexOf(e.b),
      len: Math.round(len * 10) / 10,
      time: Math.round((len / speedFor(tags)) * 10) / 10,
      t: tagIndexFor(e.wayId),
      geom,
    });
  }

  // ---- 7. Write ---------------------------------------------------------
  const artifact = {
    meta: {
      builtAt: new Date().toISOString(),
      source: "OpenStreetMap contributors, ODbL",
      nodes: lons.length,
      edges: edges.length,
      totalKm: Math.round(totalM / 100) / 10,
    },
    nodes: { lon: lons, lat: lats },
    tagSets,
    edges,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  const json = JSON.stringify(artifact);
  await writeFile(OUT_FILE, json);

  console.log(
    `\n${edges.length} edges · ${lons.length} nodes · ` +
      `${artifact.meta.totalKm} km walkable · ${tagSets.length} tag sets`,
  );
  console.log(`→ data/graph.json (${(json.length / 1e6).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
