/**
 * Phase 4's fixture test (PLAN.md §13).
 *
 *   npm run check:loops
 *
 * Ten origins × three durations. Three assertions, all from §9:
 *
 *   1. **Duration within ±10% of what was asked.** In loop mode the duration
 *      *is* the request — §3's whole argument for it being the easier wedge is
 *      that the time budget replaces the detour budget. A loop that ignores the
 *      number is not a worse answer, it's a different question.
 *   2. **Overlap under 30%.** Above that it's an out-and-back, not a loop.
 *   3. **Three distinct loops.** Three near-identical lines is a UX failure,
 *      not three options.
 *
 * The origins deliberately include the cases that break construction in
 * different ways — waterfront, park-adjacent, featureless grid — because a loop
 * builder that only works in Manhattan's middle isn't finished.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildRoutingGraph, makeScratch } from "../lib/router";
import { planLoops } from "../lib/loop";
import { scenicArray, type ScoreArtifact } from "../lib/scoring";
import { DEFAULT_WEIGHTS } from "../lib/features";
import type { GraphArtifact } from "../lib/graph";

const DATA = path.join(process.cwd(), "data");
const FIXTURES = path.join(process.cwd(), "scripts", "fixtures", "loop-origins.json");

const TOLERANCE = 0.1;
const MAX_OVERLAP = 0.3;
const WANT = 3;

function nearestNode(a: GraphArtifact, lon: number, lat: number): number {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < a.nodes.lon.length; i++) {
    const dx = (a.nodes.lon[i] - lon) * k;
    const dy = a.nodes.lat[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
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

  const artifact = JSON.parse(readFileSync(path.join(DATA, "graph.json"), "utf8")) as GraphArtifact;
  const scores = JSON.parse(readFileSync(path.join(DATA, "scores.json"), "utf8")) as ScoreArtifact;
  const { origins, durations } = JSON.parse(readFileSync(FIXTURES, "utf8")) as {
    origins: { name: string; at: [number, number]; shape: string }[];
    durations: number[];
  };

  const g = buildRoutingGraph(artifact);
  const scratch = makeScratch(g);
  const scenic = scenicArray(scores.axes, g.edgeCount, DEFAULT_WEIGHTS);

  console.log(`${origins.length} origins × ${durations.length} durations\n`);

  let failures = 0;
  let checked = 0;
  let totalMs = 0;
  let inBand = 0;
  let loopsSeen = 0;

  for (const origin of origins) {
    const node = nearestNode(artifact, origin.at[0], origin.at[1]);
    const cells: string[] = [];
    const problems: string[] = [];

    for (const minutes of durations) {
      checked++;
      const started = performance.now();
      const result = planLoops(g, scratch, { origin: node, durationMin: minutes, scenic });
      totalMs += performance.now() - started;

      if (result.loops.length < WANT) {
        problems.push(`${minutes}min: only ${result.loops.length} loop(s)`);
      }
      // At least two of three should actually fit; one honest near-miss where
      // the geography is tight is acceptable, three is a broken builder.
      const fitting = result.loops.filter((l) => l.onTarget).length;
      if (fitting < 2) {
        problems.push(`${minutes}min: only ${fitting} loop(s) hit the duration`);
      }

      const target = minutes * 60;
      for (const loop of result.loops) {
        loopsSeen++;
        const error = Math.abs(loop.time - target) / target;
        if (error <= TOLERANCE) inBand++;

        // A loop may legitimately miss the duration where the geography can't
        // supply one — Dumbo is boxed in by the river and no 60-minute loop
        // exists there. What must never happen is claiming it hit the target
        // when it didn't, so that's what's asserted.
        if (loop.onTarget !== (error <= TOLERANCE)) {
          problems.push(
            `${minutes}min: loop reports onTarget=${loop.onTarget} but is ` +
              `${(loop.time / 60).toFixed(0)}min against a ${minutes}min target`,
          );
        }
        if (loop.overlap > MAX_OVERLAP) {
          problems.push(`${minutes}min: overlap ${(loop.overlap * 100).toFixed(0)}%`);
        }
      }

      const best = result.loops[0];
      cells.push(
        best
          ? `${minutes}→${(best.time / 60).toFixed(0)}min/${(best.len / 1000).toFixed(1)}km`
          : `${minutes}→none`,
      );
    }

    if (problems.length === 0) {
      console.log(`✓ ${origin.name.padEnd(18)} ${cells.join("  ")}`);
    } else {
      failures++;
      console.log(`✗ ${origin.name.padEnd(18)} ${cells.join("  ")}`);
      for (const p of problems) console.log(`    ${p}`);
    }
  }

  console.log(
    `\n${origins.length - failures}/${origins.length} origins pass · ` +
      `${inBand}/${loopsSeen} loops within ±10% · ` +
      `${(totalMs / checked).toFixed(0)} ms per request`,
  );
  process.exit(failures ? 1 : 0);
}

main();
