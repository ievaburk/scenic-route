/**
 * Phase 3's fixture test (PLAN.md §13).
 *
 *   npm run check:interests
 *
 * Two halves, and the second is the one that matters.
 *
 * **Resolution** — phrases land in the right category. Things OSM knows about
 * resolve with a real count; things it half-knows resolve but stay thin; things
 * we never extracted say so; things that aren't in OSM and never will be
 * ("smells like bakeries") fail honestly rather than resolving to a dead
 * weight.
 *
 * **Effect** — a route asked for bridges contains measurably more bridge than
 * the same route unasked. §13 calls this "the test that proves the feature does
 * anything at all", and it's the one that would catch a layer that resolves,
 * reports a healthy count, and then contributes nothing because it's wired up
 * wrong. A dictionary can look perfect and still be inert.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildRoutingGraph, makeScratch } from "../lib/router";
import { planRoutes } from "../lib/plan-route";
import { scenicArray, type ScoreArtifact } from "../lib/scoring";
import { DEFAULT_WEIGHTS } from "../lib/features";
import { resolveInterest, validateFilter, DICTIONARY } from "../lib/interests";
import { applyInterests, interestLayer } from "../lib/interest-layers";
import type { GraphArtifact } from "../lib/graph";

const DATA = path.join(process.cwd(), "data");
const FIXTURES = path.join(process.cwd(), "scripts", "fixtures", "interests.json");

const SLACK_MIN = 20;
const INTEREST_WEIGHT = 0.6;

type PhraseFixture = {
  phrase: string;
  expect: "resolved" | "unresolved" | "not-extracted";
  id?: string;
  minMatches?: number;
  maxMatches?: number;
};

type RouteFixture = {
  name: string;
  from: [number, number];
  to: [number, number];
  interest: string;
  minGainMetres: number;
};

function nearestNode(a: GraphArtifact, lon: number, lat: number): number {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < a.nodes.lon.length; i++) {
    const dx = (a.nodes.lon[i] - lon) * k;
    const dy = a.nodes.lat[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
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
  const { phrases, routeTests } = JSON.parse(readFileSync(FIXTURES, "utf8")) as {
    phrases: PhraseFixture[];
    routeTests: RouteFixture[];
  };

  let failures = 0;

  // ---- 1. Resolution ------------------------------------------------------
  console.log(`${phrases.length} phrases\n`);

  for (const fx of phrases) {
    const r = resolveInterest(fx.phrase);
    const label = `"${fx.phrase}"`.padEnd(34);

    if (fx.expect === "unresolved") {
      if (r.status === "unresolved") {
        console.log(`✓ ${label} unresolved, as it should be`);
      } else {
        failures++;
        console.log(`✗ ${label} resolved to "${r.entry.id}" — expected no match`);
      }
      continue;
    }

    if (r.status === "unresolved") {
      failures++;
      console.log(`✗ ${label} didn't resolve`);
      continue;
    }

    if (fx.id && r.entry.id !== fx.id) {
      failures++;
      console.log(`✗ ${label} resolved to "${r.entry.id}", expected "${fx.id}"`);
      continue;
    }

    if (!validateFilter(r.entry.filter).ok) {
      failures++;
      console.log(`✗ ${label} produced a filter that fails validation`);
      continue;
    }

    const layer = interestLayer(r.entry, artifact);

    if (fx.expect === "not-extracted") {
      if (layer.coverage === "not-extracted") {
        console.log(`✓ ${label} correctly reported as not extracted`);
      } else {
        failures++;
        console.log(
          `✗ ${label} reported ${layer.matchCount} matches — should say we ` +
            `never extracted it, not invent a number`,
        );
      }
      continue;
    }

    const problems: string[] = [];
    if (layer.coverage === "not-extracted") problems.push("reported not-extracted");
    if (fx.minMatches !== undefined && layer.matchCount < fx.minMatches) {
      problems.push(`${layer.matchCount} matches, expected at least ${fx.minMatches}`);
    }
    if (fx.maxMatches !== undefined && layer.matchCount > fx.maxMatches) {
      problems.push(`${layer.matchCount} matches, expected at most ${fx.maxMatches}`);
    }

    if (problems.length) {
      failures++;
      console.log(`✗ ${label} ${problems.join("; ")}`);
    } else {
      console.log(
        `✓ ${label} → ${r.entry.id.padEnd(16)} ${String(layer.matchCount).padStart(6)} matches` +
          (layer.coverage === "thin" ? " (thin, and says so)" : ""),
      );
    }
  }

  // ---- 2. Effect on real routes ------------------------------------------
  console.log(`\n${routeTests.length} route tests — does asking actually change the walk?\n`);

  const g = buildRoutingGraph(artifact);
  const scratch = makeScratch(g);
  const core = scenicArray(scores.axes, g.edgeCount, DEFAULT_WEIGHTS);

  for (const fx of routeTests) {
    const entry = DICTIONARY.find((d) => d.id === fx.interest);
    if (!entry) {
      failures++;
      console.log(`✗ ${fx.name}: no dictionary entry "${fx.interest}"`);
      continue;
    }
    const layer = interestLayer(entry, artifact);
    const source = nearestNode(artifact, fx.from[0], fx.from[1]);
    const target = nearestNode(artifact, fx.to[0], fx.to[1]);

    /** Metres of a plan's most-scenic route that actually touch the interest. */
    const metres = (scenic: Float32Array) => {
      const plan = planRoutes(g, scratch, { source, target, scenic, slackMin: SLACK_MIN });
      if (!plan) return null;
      const best = plan.routes.reduce((a, b) => (b.scenic > a.scenic ? b : a));
      let m = 0;
      for (const e of best.edges) if (layer.scores.has(e)) m += g.len[e];
      return { m, time: best.time };
    };

    const without = metres(core);
    const withIt = metres(applyInterests(core, [{ layer, weight: INTEREST_WEIGHT }]));

    if (!without || !withIt) {
      failures++;
      console.log(`✗ ${fx.name}: no route`);
      continue;
    }

    const gain = withIt.m - without.m;
    const ok = gain >= fx.minGainMetres;
    if (!ok) failures++;

    console.log(
      `${ok ? "✓" : "✗"} ${fx.name.padEnd(28)} ${entry.label.padEnd(20)} ` +
        `${Math.round(without.m)}m → ${Math.round(withIt.m)}m ` +
        `(+${Math.round(gain)}m, need +${fx.minGainMetres}) ` +
        `· ${(withIt.time / 60).toFixed(0)}min`,
    );
  }

  const total = phrases.length + routeTests.length;
  console.log(`\n${total - failures}/${total} pass`);
  process.exit(failures ? 1 : 0);
}

main();
