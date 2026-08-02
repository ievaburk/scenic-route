/**
 * Prove the bidirectional A* is actually optimal.
 *
 *   npm run check:router
 *
 * A subtly wrong bidirectional search returns paths that look completely
 * reasonable drawn on a map — slightly long, slightly odd, indistinguishable
 * from a route that simply preferred a different street. So "it looks fine" is
 * not evidence of anything. This compares it against plain Dijkstra over the
 * identical cost function on random node pairs, at several values of α, and
 * fails on any cost difference beyond float noise.
 *
 * Worth keeping fast enough to run on every change to `lib/router.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildRoutingGraph,
  findRoute,
  findRouteDijkstra,
  makeScratch,
  routeCost,
} from "../lib/router";
import { compositeScore, type ScoreArtifact } from "../lib/scoring";
import { DEFAULT_WEIGHTS } from "../lib/features";
import type { GraphArtifact } from "../lib/graph";

const DATA = path.join(process.cwd(), "data");
const PAIRS = 60;
const ALPHAS = [0, 0.3, 0.6, 0.85];
/** Costs are seconds; a millisecond of float drift is not a bug. */
const TOLERANCE = 1e-3;

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main() {
  for (const f of ["graph.json", "scores.json"]) {
    if (!existsSync(path.join(DATA, f))) {
      console.error(`No data/${f}. Run the pipeline first.`);
      process.exit(1);
    }
  }

  const artifact = JSON.parse(
    readFileSync(path.join(DATA, "graph.json"), "utf8"),
  ) as GraphArtifact;
  const scores = JSON.parse(
    readFileSync(path.join(DATA, "scores.json"), "utf8"),
  ) as ScoreArtifact;

  if (scores.meta.graphBuiltAt !== artifact.meta.builtAt) {
    console.error("scores.json is stale — re-run `npm run score:graph`.");
    process.exit(1);
  }

  const g = buildRoutingGraph(artifact);
  const scratch = makeScratch(g);

  const scenic = new Float32Array(g.edgeCount);
  for (let i = 0; i < g.edgeCount; i++) {
    scenic[i] = compositeScore(scores.axes, i, DEFAULT_WEIGHTS);
  }

  console.log(
    `${g.nodeCount} nodes, ${g.edgeCount} edges · ` +
      `${PAIRS} pairs × ${ALPHAS.length} alphas\n`,
  );

  const rand = mulberry32(20260802);
  let failures = 0;
  let checked = 0;
  let astarMs = 0;
  let dijkstraMs = 0;
  let worstGap = 0;

  for (let p = 0; p < PAIRS; p++) {
    const source = Math.floor(rand() * g.nodeCount);
    const target = Math.floor(rand() * g.nodeCount);
    if (source === target) continue;

    for (const alpha of ALPHAS) {
      const opts = { scenic, alpha };

      let t = performance.now();
      const fast = findRoute(g, scratch, source, target, opts);
      astarMs += performance.now() - t;

      t = performance.now();
      const reference = findRouteDijkstra(g, source, target, opts);
      dijkstraMs += performance.now() - t;

      checked++;

      if (!fast || !reference) {
        if (fast !== reference) {
          console.log(
            `✗ ${source}→${target} α=${alpha}: one search found a path and the other didn't`,
          );
          failures++;
        }
        continue;
      }

      const a = routeCost(g, fast, opts);
      const b = routeCost(g, reference, opts);
      const gap = a - b;
      if (gap > worstGap) worstGap = gap;

      // A* may legitimately return a *different* path of equal cost; only a
      // more expensive one is a bug.
      if (gap > TOLERANCE) {
        failures++;
        console.log(
          `✗ ${source}→${target} α=${alpha}: A* cost ${a.toFixed(3)} vs ` +
            `Dijkstra ${b.toFixed(3)} (worse by ${gap.toFixed(3)}s)`,
        );
      }
    }
  }

  console.log(
    `A*       ${(astarMs / checked).toFixed(2)} ms/route\n` +
      `Dijkstra ${(dijkstraMs / checked).toFixed(2)} ms/route  ` +
      `(${(dijkstraMs / astarMs).toFixed(1)}× slower)\n` +
      `worst cost gap: ${worstGap.toExponential(2)}s\n`,
  );

  if (failures) {
    console.log(`${failures}/${checked} suboptimal — the search is wrong`);
    process.exit(1);
  }
  console.log(`${checked}/${checked} optimal`);
}

main();
