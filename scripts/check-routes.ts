/**
 * Phase 2's fixture test (PLAN.md §13).
 *
 *   npm run check:routes
 *
 * Twenty committed O/D pairs across the pilot area. For each, three claims the
 * router has to keep or the engine is broken:
 *
 *   1. **Every route fits the budget.** A route that made someone late is the
 *      failure mode §3 says loses the user for good.
 *   2. **Scenic value increases with α.** This is the one that proves the
 *      discount does anything at all. If scenic didn't rise with greed, the
 *      whole `time · (1 − α · scenic)` formulation would be decoration.
 *   3. **The alternates are distinct**, sharing under 60% of their length.
 *      Three near-identical lines is a UX failure, not three options.
 *
 * Claim 2 is checked per-pair as a monotone sweep at fixed α rather than
 * through `planRoutes`, because the plan's three routes are chosen for
 * distinctness too — a diverted alternate can legitimately score lower than
 * the route it was diverted from.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildRoutingGraph,
  findRoute,
  makeScratch,
  type RoutingGraph,
} from "../lib/router";
import { overlapFraction, planRoutes } from "../lib/plan-route";
import { compositeScore, type ScoreArtifact } from "../lib/scoring";
import { DEFAULT_WEIGHTS } from "../lib/features";
import type { GraphArtifact } from "../lib/graph";

const DATA = path.join(process.cwd(), "data");
const FIXTURES = path.join(process.cwd(), "scripts", "fixtures", "od-pairs.json");

const SLACK_MIN = 15;
const SWEEP = [0, 0.3, 0.6, 0.9];
/** Percentile scores are 3dp; anything smaller than this is noise, not a trend. */
const SCENIC_EPSILON = 1e-4;
const MAX_OVERLAP = 0.6;

type Fixture = { name: string; from: [number, number]; to: [number, number] };

function nearestNode(
  artifact: GraphArtifact,
  lon: number,
  lat: number,
): number {
  const lonScale = Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let bestD = Infinity;
  for (let n = 0; n < artifact.nodes.lon.length; n++) {
    const dx = (artifact.nodes.lon[n] - lon) * lonScale;
    const dy = artifact.nodes.lat[n] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
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

  const { pairs } = JSON.parse(readFileSync(FIXTURES, "utf8")) as {
    pairs: Fixture[];
  };

  const g: RoutingGraph = buildRoutingGraph(artifact);
  const scratch = makeScratch(g);
  const scenic = new Float32Array(g.edgeCount);
  for (let i = 0; i < g.edgeCount; i++) {
    scenic[i] = compositeScore(scores.axes, i, DEFAULT_WEIGHTS);
  }

  console.log(`${pairs.length} pairs · slack +${SLACK_MIN} min\n`);

  let failures = 0;
  let totalMs = 0;
  let gained = 0;

  for (const fx of pairs) {
    const source = nearestNode(artifact, fx.from[0], fx.from[1]);
    const target = nearestNode(artifact, fx.to[0], fx.to[1]);

    const started = performance.now();
    const plan = planRoutes(g, scratch, {
      source, target, scenic, slackMin: SLACK_MIN,
    });
    const ms = performance.now() - started;
    totalMs += ms;

    if (!plan || plan.routes.length === 0) {
      console.log(`✗ ${fx.name}: no route`);
      failures++;
      continue;
    }

    const problems: string[] = [];

    // 1. Budget.
    for (const r of plan.routes) {
      if (r.time > plan.budget + 1e-6) {
        problems.push(
          `route at α=${r.alpha.toFixed(2)} takes ${(r.time / 60).toFixed(1)}min, ` +
            `over the ${(plan.budget / 60).toFixed(1)}min budget`,
        );
      }
    }

    // 2. Scenic value rises with α.
    let previous = -Infinity;
    const sweep: number[] = [];
    for (const alpha of SWEEP) {
      const r = findRoute(g, scratch, source, target, { scenic, alpha });
      if (!r) {
        problems.push(`no route at α=${alpha}`);
        break;
      }
      sweep.push(r.scenic);
      if (r.scenic < previous - SCENIC_EPSILON) {
        problems.push(
          `scenic fell from ${previous.toFixed(4)} to ${r.scenic.toFixed(4)} at α=${alpha}`,
        );
      }
      previous = r.scenic;
    }
    if (sweep.length === SWEEP.length && sweep[sweep.length - 1] > sweep[0]) {
      gained++;
    }

    // 3. Alternates are distinct.
    for (let i = 1; i < plan.routes.length; i++) {
      const share = overlapFraction(g, plan.routes[i], plan.routes.slice(0, i));
      if (share > MAX_OVERLAP + 1e-9) {
        problems.push(
          `route ${i} shares ${(share * 100).toFixed(0)}% of its length with an earlier one`,
        );
      }
    }

    const first = sweep[0] ?? 0;
    const last = sweep[sweep.length - 1] ?? 0;
    const lift = first > 0 ? ((last - first) / first) * 100 : 0;

    if (problems.length === 0) {
      console.log(
        `✓ ${fx.name.padEnd(32)} ${plan.routes.length} routes · ` +
          `${(plan.routes[0].time / 60).toFixed(0)}min · ` +
          `scenic ${first.toFixed(3)}→${last.toFixed(3)} (+${lift.toFixed(0)}%) · ` +
          `${ms.toFixed(0)}ms`,
      );
    } else {
      failures++;
      console.log(`✗ ${fx.name}`);
      for (const p of problems) console.log(`    ${p}`);
    }
  }

  console.log(
    `\n${pairs.length - failures}/${pairs.length} pairs pass · ` +
      `${gained}/${pairs.length} gained scenic value from α · ` +
      `${(totalMs / pairs.length).toFixed(0)} ms/plan`,
  );

  process.exit(failures ? 1 : 0);
}

main();
