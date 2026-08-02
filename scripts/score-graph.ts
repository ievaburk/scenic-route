/**
 * Score every edge in the graph on the six scenic axes.
 *
 *   npm run score:graph
 *
 * Reads data/graph.json plus the feature extracts from `fetch:features`, and
 * writes data/scores.json — six arrays of 0–1, index-aligned with graph.edges.
 * Fast enough to re-run constantly, which is the point: tuning what "scenic"
 * means should cost seconds, not another trip to Overpass.
 *
 * The shape of the computation (PLAN.md §7):
 *
 *   1. Project everything to metres. A city-sized equirectangular projection is
 *      sub-metre accurate and turns millions of distance tests into arithmetic.
 *   2. Index every scenic feature in an R-tree, its bbox pre-expanded by that
 *      feature's reach — so a query is "what can reach this point" rather than
 *      "what's nearby, now check each one".
 *   3. Sample each edge every 25 m, sum decayed contributions per axis at each
 *      sample, saturate, average along the edge.
 *   4. Percentile-normalise each axis across the city.
 *
 * `quiet` skips steps 1–3 entirely: nothing in OSM tags it, so it comes from
 * the edge's own road class. See `quietScore`.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import RBush from "rbush";
import {
  AXIS_KEYS,
  DISTRICT_WEIGHTS,
  classify,
  type ScenicAxis,
} from "../lib/features";
import {
  decay,
  percentileNormalise,
  quietScore,
  saturate,
  type ScoreArtifact,
} from "../lib/scoring";
import {
  distToPolyline,
  pointInRing,
  projector,
} from "../lib/geo";
import { PILOT } from "../lib/pilot";
import type { GraphArtifact } from "../lib/graph";

const DATA_DIR = path.join(process.cwd(), "data");
const RAW_DIR = path.join(DATA_DIR, "raw");
const GRAPH_FILE = path.join(DATA_DIR, "graph.json");
const OUT_FILE = path.join(DATA_DIR, "scores.json");

/** Distance between sample points along an edge. The mean edge is ~29 m. */
const SAMPLE_M = 25;

/** Street trees, from the census. Weak individually, decisive in aggregate. */
const TREE = { weight: 0.15, reach: 25 };

/** Historic districts are whole-block signals — they apply to what's inside them. */
const DISTRICT_REACH = 25;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

type Geom =
  | { kind: "point"; x: number; y: number }
  | { kind: "line"; xs: Float64Array; ys: Float64Array }
  | { kind: "area"; xs: Float64Array; ys: Float64Array };

/** One feature's influence on one axis, as indexed in that axis's R-tree. */
type Item = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  g: number;
  weight: number;
  reach: number;
};

function distanceTo(geom: Geom, px: number, py: number): number {
  switch (geom.kind) {
    case "point":
      return Math.hypot(px - geom.x, py - geom.y);
    case "line":
      return distToPolyline(px, py, geom.xs, geom.ys);
    case "area":
      // Inside scores as if standing on it. Without this, the middle of
      // Central Park decays to nothing and the park's own paths — the whole
      // reason the axis exists — score zero for green.
      if (pointInRing(px, py, geom.xs, geom.ys)) return 0;
      return distToPolyline(px, py, geom.xs, geom.ys);
  }
}

// ---------------------------------------------------------------------------
// Feature collection
// ---------------------------------------------------------------------------

type OsmLatLon = { lat: number; lon: number };

const samePoint = (a: OsmLatLon, b: OsmLatLon) =>
  a.lat === b.lat && a.lon === b.lon;

const isClosed = (ring: OsmLatLon[]) =>
  ring.length >= 4 && samePoint(ring[0], ring[ring.length - 1]);

/**
 * Stitch a multipolygon relation's outer members into closed rings.
 *
 * Necessary, not tidiness: OSM routinely splits a large park's boundary across
 * several ways, so a relation's members are usually *open* chains that only
 * form a ring once joined end to end. Treating each member on its own leaves
 * every such park with no interior — Prospect Park and Governors Island both
 * come back that way in the pilot extract — and "inside a park" is precisely
 * where the paths we most want to score highly are.
 *
 * Overpass emits the shared node's coordinates identically in both members, so
 * exact equality is the right join test. Inner rings (holes) are dropped rather
 * than stitched: treating a hole as solid slightly over-credits the middle of a
 * donut-shaped park, which is far cheaper than getting even-odd fill right.
 */
function assembleRings(
  members: { role?: string; geometry?: OsmLatLon[] }[],
): OsmLatLon[][] {
  const segments = members
    .filter((m) => m.geometry && m.geometry.length >= 2 && m.role !== "inner")
    .map((m) => m.geometry!);

  const used = new Array<boolean>(segments.length).fill(false);
  const out: OsmLatLon[][] = [];

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const chain = segments[i].slice();

    // Walk forward from the chain's end, consuming whichever unused segment
    // starts or ends there, until it closes or nothing else connects.
    for (let extended = true; extended && !isClosed(chain); ) {
      extended = false;
      const end = chain[chain.length - 1];

      for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue;
        const s = segments[j];

        if (samePoint(s[0], end)) {
          for (let k = 1; k < s.length; k++) chain.push(s[k]);
        } else if (samePoint(s[s.length - 1], end)) {
          for (let k = s.length - 2; k >= 0; k--) chain.push(s[k]);
        } else {
          continue;
        }

        used[j] = true;
        extended = true;
        break;
      }
    }

    out.push(chain);
  }

  return out;
}

type OsmFeature = {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  geometry?: OsmLatLon[];
  members?: { type: string; role?: string; geometry?: OsmLatLon[] }[];
};

async function main() {
  if (!existsSync(GRAPH_FILE)) {
    throw new Error("No data/graph.json. Run `npm run build:graph` first.");
  }

  console.log("loading graph…");
  const graph = JSON.parse(
    await readFile(GRAPH_FILE, "utf8"),
  ) as GraphArtifact;
  console.log(`${graph.edges.length} edges, ${graph.tagSets.length} tag sets`);

  const proj = projector(PILOT.bbox.west, PILOT.bbox.south);

  const geoms: Geom[] = [];
  /** One R-tree per axis. `quiet` never gets one — it isn't proximity-based. */
  const items: Record<string, Item[]> = {};
  const sources: Record<string, number> = {};

  /** Register geometry `g`'s contribution to an axis, bbox expanded by reach. */
  function add(g: number, axis: ScenicAxis, weight: number, reach: number) {
    const geom = geoms[g];
    let minX: number, minY: number, maxX: number, maxY: number;

    if (geom.kind === "point") {
      minX = maxX = geom.x;
      minY = maxY = geom.y;
    } else {
      minX = minY = Infinity;
      maxX = maxY = -Infinity;
      for (let i = 0; i < geom.xs.length; i++) {
        if (geom.xs[i] < minX) minX = geom.xs[i];
        if (geom.xs[i] > maxX) maxX = geom.xs[i];
        if (geom.ys[i] < minY) minY = geom.ys[i];
        if (geom.ys[i] > maxY) maxY = geom.ys[i];
      }
    }

    (items[axis] ??= []).push({
      minX: minX - reach,
      minY: minY - reach,
      maxX: maxX + reach,
      maxY: maxY + reach,
      g,
      weight,
      reach,
    });
  }

  /** Append a way's geometry and return its index, or -1 if unusable. */
  function pushRing(coords: OsmLatLon[]): number {
    if (coords.length < 2) return -1;
    const xs = new Float64Array(coords.length);
    const ys = new Float64Array(coords.length);
    for (let i = 0; i < coords.length; i++) {
      xs[i] = proj.x(coords[i].lon);
      ys[i] = proj.y(coords[i].lat);
    }
    const closed =
      coords.length >= 4 &&
      coords[0].lat === coords[coords.length - 1].lat &&
      coords[0].lon === coords[coords.length - 1].lon;
    geoms.push(closed ? { kind: "area", xs, ys } : { kind: "line", xs, ys });
    return geoms.length - 1;
  }

  // ---- 1. OSM scenic features -------------------------------------------
  const featFiles = (await readdir(RAW_DIR)).filter(
    (f) => f.startsWith("feat_") && f.endsWith(".json"),
  );
  if (featFiles.length === 0) {
    throw new Error(
      `No feat_*.json in ${RAW_DIR}. Run \`npm run fetch:features\` first.`,
    );
  }

  const treesFile = path.join(RAW_DIR, "nyc_street_trees.json");
  const haveCensus = existsSync(treesFile);

  // A way straddling a tile boundary comes back from both tiles.
  const seen = new Set<string>();
  let osmFeatures = 0;
  let skippedOsmTrees = 0;

  for (const f of featFiles) {
    const raw = JSON.parse(
      await readFile(path.join(RAW_DIR, f), "utf8"),
    ) as { elements: OsmFeature[] };

    for (const el of raw.elements) {
      const key = `${el.type}/${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const tags = el.tags;
      if (!tags) continue;

      // The census is a complete, uniform survey; OSM's tree nodes are patchy
      // and biased toward whichever blocks a mapper cared about. Mixing them
      // would reintroduce exactly the coverage bias the census removes.
      if (haveCensus && tags.natural === "tree") {
        skippedOsmTrees++;
        continue;
      }

      const contributions = classify(tags);
      if (contributions.length === 0) continue;

      // Collect this element's geometries once, then attach every axis to each.
      const parts: number[] = [];
      if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
        geoms.push({ kind: "point", x: proj.x(el.lon), y: proj.y(el.lat) });
        parts.push(geoms.length - 1);
      } else if (el.geometry) {
        const g = pushRing(el.geometry);
        if (g >= 0) parts.push(g);
      } else if (el.members) {
        // Members are usually open chains that only form a ring once joined —
        // see assembleRings. Whatever still doesn't close (a river relation,
        // a boundary clipped by the pilot bbox) falls through as a line, which
        // is the right treatment for it anyway.
        for (const ring of assembleRings(el.members)) {
          const g = pushRing(ring);
          if (g >= 0) parts.push(g);
        }
      }
      if (parts.length === 0) continue;

      for (const g of parts) {
        for (const c of contributions) add(g, c.axis, c.weight, c.reach);
      }
      osmFeatures++;
    }
  }
  sources.osm = osmFeatures;
  console.log(
    `${osmFeatures} OSM scenic features from ${featFiles.length} tiles` +
      (skippedOsmTrees ? ` (${skippedOsmTrees} OSM trees deferred to census)` : ""),
  );

  // ---- 2. NYC historic districts ----------------------------------------
  const districtFile = path.join(RAW_DIR, "nyc_historic_districts.json");
  if (existsSync(districtFile)) {
    const fc = JSON.parse(await readFile(districtFile, "utf8")) as {
      features: {
        properties: { variable_type?: string };
        geometry: { type: string; coordinates: number[][][] | number[][][][] };
      }[];
    };

    let count = 0;
    for (const f of fc.features) {
      const rule = DISTRICT_WEIGHTS[f.properties.variable_type ?? ""];
      if (!rule) continue;

      const polys =
        f.geometry.type === "MultiPolygon"
          ? (f.geometry.coordinates as number[][][][])
          : [f.geometry.coordinates as number[][][]];

      for (const poly of polys) {
        // Outer ring only — see the multipolygon note above.
        const ring = poly[0];
        if (!ring || ring.length < 4) continue;
        const xs = new Float64Array(ring.length);
        const ys = new Float64Array(ring.length);
        for (let i = 0; i < ring.length; i++) {
          xs[i] = proj.x(ring[i][0]);
          ys[i] = proj.y(ring[i][1]);
        }
        geoms.push({ kind: "area", xs, ys });
        add(geoms.length - 1, rule.axis, rule.weight, DISTRICT_REACH);
        count++;
      }
    }
    sources.historicDistricts = count;
    console.log(`${count} historic district polygons`);
  } else {
    console.log("no historic districts on disk — skipping (run fetch:features)");
  }

  // ---- 3. Street tree census --------------------------------------------
  if (haveCensus) {
    const { trees } = JSON.parse(await readFile(treesFile, "utf8")) as {
      trees: [number, number][];
    };
    for (const [lon, lat] of trees) {
      geoms.push({ kind: "point", x: proj.x(lon), y: proj.y(lat) });
      add(geoms.length - 1, "green", TREE.weight, TREE.reach);
    }
    sources.streetTrees = trees.length;
    console.log(`${trees.length} street trees`);
  } else {
    console.log("no street tree census on disk — skipping (run fetch:features)");
  }

  // ---- 4. Index ----------------------------------------------------------
  const trees: Partial<Record<ScenicAxis, RBush<Item>>> = {};
  for (const axis of AXIS_KEYS) {
    const list = items[axis];
    if (!list?.length) continue;
    const tree = new RBush<Item>();
    tree.load(list);
    trees[axis] = tree;
    console.log(`  ${axis}: ${list.length} indexed contributions`);
  }

  // ---- 5. Score every edge ----------------------------------------------
  const n = graph.edges.length;
  const rawByAxis: Record<string, Float64Array> = {};
  for (const axis of AXIS_KEYS) rawByAxis[axis] = new Float64Array(n);

  const proximityAxes = AXIS_KEYS.filter((a) => trees[a]);

  console.log(`scoring ${n} edges…`);
  const started = Date.now();

  // Reused across edges to keep the hot loop out of the allocator.
  const sx: number[] = [];
  const sy: number[] = [];

  for (let ei = 0; ei < n; ei++) {
    const e = graph.edges[ei];
    const tags = graph.tagSets[e.t] ?? {};

    // --- sample points along the edge, in metres ---
    sx.length = 0;
    sy.length = 0;
    let carry = 0;
    let px = proj.x(e.geom[0]);
    let py = proj.y(e.geom[1]);
    sx.push(px);
    sy.push(py);

    for (let i = 2; i < e.geom.length; i += 2) {
      const qx = proj.x(e.geom[i]);
      const qy = proj.y(e.geom[i + 1]);
      const segLen = Math.hypot(qx - px, qy - py);
      if (segLen > 0) {
        let t = SAMPLE_M - carry;
        while (t < segLen) {
          sx.push(px + ((qx - px) * t) / segLen);
          sy.push(py + ((qy - py) * t) / segLen);
          t += SAMPLE_M;
        }
        carry = (carry + segLen) % SAMPLE_M;
      }
      px = qx;
      py = qy;
    }
    sx.push(px);
    sy.push(py);

    // --- accumulate per axis over the samples ---
    for (const axis of proximityAxes) {
      const tree = trees[axis]!;
      let total = 0;

      for (let s = 0; s < sx.length; s++) {
        const hits = tree.search({
          minX: sx[s],
          minY: sy[s],
          maxX: sx[s],
          maxY: sy[s],
        });
        if (hits.length === 0) continue;

        let sum = 0;
        for (const hit of hits) {
          const d = distanceTo(geoms[hit.g], sx[s], sy[s]);
          if (d < hit.reach) sum += hit.weight * decay(d, hit.reach);
        }
        total += saturate(sum);
      }

      rawByAxis[axis][ei] = total / sx.length;
    }

    // --- derived axes ---
    rawByAxis.quiet[ei] = quietScore(tags);

    // A bridge is a view by construction, and `bridge=yes` on the edge itself
    // is far better mapped than the `man_made=bridge` outlines.
    if (tags.bridge && tags.bridge !== "no") {
      rawByAxis.hills[ei] = Math.max(rawByAxis.hills[ei], 0.7);
    }

    if ((ei + 1) % 40_000 === 0) {
      console.log(`  ${ei + 1}/${n}`);
    }
  }
  console.log(`scored in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // ---- 6. Percentile-normalise and write ---------------------------------
  const axes = {} as ScoreArtifact["axes"];
  for (const axis of AXIS_KEYS) {
    const norm = percentileNormalise(rawByAxis[axis]);
    // 3dp is well below what any colour ramp or routing decision can resolve,
    // and keeps the artifact from tripling in size on float noise.
    axes[axis] = Array.from(norm, (v) => Math.round(v * 1000) / 1000);

    const nonZero = axes[axis].filter((v) => v > 0).length;
    console.log(
      `  ${axis.padEnd(13)} ${nonZero} edges scored ` +
        `(${((nonZero / n) * 100).toFixed(1)}%)`,
    );
  }

  const artifact: ScoreArtifact = {
    meta: {
      builtAt: new Date().toISOString(),
      graphBuiltAt: graph.meta.builtAt,
      edges: n,
      sources,
    },
    axes,
  };

  await mkdir(DATA_DIR, { recursive: true });
  const json = JSON.stringify(artifact);
  await writeFile(OUT_FILE, json);
  console.log(`\n→ data/scores.json (${(json.length / 1e6).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
