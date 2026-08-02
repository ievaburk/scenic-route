/**
 * The Phase 1 ship-blocking check (PLAN.md §12, §13).
 *
 *   npm run check:landmarks
 *
 * A held-out set of places in the pilot area whose character is not in
 * dispute, each with the score band it ought to land in. Riverside Park, the
 * Brooklyn Heights Promenade and the Hudson River Greenway should glow. 8th
 * Avenue in Midtown should not.
 *
 * PLAN.md §11 is blunt that there is no ground truth for "scenic" and that the
 * only real evaluation is walking the routes — this is not a substitute for
 * that. What it is, is a regression net: every future change to the weights in
 * `lib/features.ts` gets re-run against the same list, so a tweak that quietly
 * makes Midtown outrank the waterfront can't land unnoticed. Re-run it on every
 * scoring change, and add to it whenever the map disagrees with you.
 *
 * Bands are deliberately wide. The claim being tested is ordering — that these
 * places rank where a New Yorker would put them — not that any edge deserves
 * a particular number.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_WEIGHTS, SCENIC_AXES, type ScenicAxis } from "../lib/features";
import { overallScore, type ScoreArtifact } from "../lib/scoring";
import type { GraphArtifact } from "../lib/graph";

const DATA_DIR = path.join(process.cwd(), "data");

type Landmark = {
  name: string;
  lon: number;
  lat: number;
  /**
   * Half-width of the sampling box as [lon, lat] degrees. Separate axes because
   * several of these places are long thin strips — Riverside Park is a
   * kilometres-long ribbon two blocks wide, and a square box centred on it
   * samples mostly the street grid next door.
   */
  radius: [number, number];
  /** Inclusive band the mean overall score should land in. */
  expect: [number, number];
  /** Why this place is in the list — the thing a reader would otherwise ask. */
  note: string;
};

/**
 * Coordinates are approximate centres; the check averages every edge whose
 * start node falls in the box, so it measures the character of the area rather
 * than the luck of one edge.
 */
const LANDMARKS: Landmark[] = [
  {
    name: "Central Park (the Ramble)",
    lon: -73.9700,
    lat: 40.7770,
    radius: [0.0025, 0.0025],
    expect: [0.6, 1],
    note: "the most obviously scenic place in the pilot area",
  },
  {
    name: "Prospect Park (Lullwater)",
    lon: -73.9690,
    lat: 40.6602,
    radius: [0.002, 0.002],
    expect: [0.55, 1],
    note: "park interior, reachable only via multipolygon ring assembly",
  },
  {
    name: "Riverside Park",
    lon: -73.9785,
    lat: 40.7960,
    radius: [0.0025, 0.004],
    expect: [0.5, 1],
    note: "PLAN.md §13 names this explicitly — green and water together",
  },
  {
    name: "Hudson River Greenway (Chelsea)",
    lon: -74.0090,
    lat: 40.7480,
    radius: [0.0015, 0.0015],
    expect: [0.5, 1],
    note: "PLAN.md §13 — green and water alone have to carry this one",
  },
  {
    name: "Brooklyn Heights Promenade",
    lon: -73.9976,
    lat: 40.6960,
    radius: [0.0012, 0.0012],
    expect: [0.45, 1],
    note: "PLAN.md §13 — water plus an LPC historic district",
  },
  {
    name: "Park Slope Historic District",
    lon: -73.9765,
    lat: 40.6700,
    radius: [0.0015, 0.0015],
    expect: [0.3, 1],
    note: "the ordinary-beautiful-street case OSM misses and LPC catches",
  },
  {
    name: "8th Ave / Midtown",
    lon: -73.9905,
    lat: 40.7550,
    radius: [0.0012, 0.0012],
    expect: [0, 0.35],
    note: "PLAN.md §13 — the explicit negative case",
  },
  {
    name: "Hell's Kitchen / Lincoln Tunnel",
    lon: -73.9975,
    lat: 40.7595,
    radius: [0.0015, 0.0015],
    expect: [0, 0.35],
    note: "second negative: tunnel approach, no canopy, no designation",
  },
];

function main() {
  const graphFile = path.join(DATA_DIR, "graph.json");
  const scoresFile = path.join(DATA_DIR, "scores.json");

  for (const [label, file] of [
    ["graph", graphFile],
    ["scores", scoresFile],
  ] as const) {
    if (!existsSync(file)) {
      console.error(
        `No ${label} artifact at ${path.relative(process.cwd(), file)}.\n` +
          "Run: npm run build:graph && npm run fetch:features && npm run score:graph",
      );
      process.exit(1);
    }
  }

  const graph = JSON.parse(readFileSync(graphFile, "utf8")) as GraphArtifact;
  const scores = JSON.parse(readFileSync(scoresFile, "utf8")) as ScoreArtifact;

  if (scores.meta.graphBuiltAt !== graph.meta.builtAt) {
    console.error(
      "scores.json was computed against a different graph — re-run `npm run score:graph`.",
    );
    process.exit(1);
  }

  console.log(
    `${LANDMARKS.length} landmarks against ${graph.edges.length} edges\n`,
  );

  let failures = 0;

  for (const lm of LANDMARKS) {
    const axisTotals: Record<string, number> = {};
    for (const a of SCENIC_AXES) axisTotals[a.key] = 0;
    let composite = 0;
    let count = 0;

    for (let i = 0; i < graph.edges.length; i++) {
      const e = graph.edges[i];
      if (
        Math.abs(e.geom[0] - lm.lon) > lm.radius[0] ||
        Math.abs(e.geom[1] - lm.lat) > lm.radius[1]
      ) {
        continue;
      }
      composite += overallScore(scores.axes, i, DEFAULT_WEIGHTS);
      for (const a of SCENIC_AXES) {
        axisTotals[a.key] += scores.axes[a.key as ScenicAxis][i] ?? 0;
      }
      count++;
    }

    if (count === 0) {
      console.log(`✗ ${lm.name}\n    no edges in the sampling box`);
      failures++;
      continue;
    }

    const mean = composite / count;
    const [lo, hi] = lm.expect;
    const ok = mean >= lo && mean <= hi;
    if (!ok) failures++;

    const breakdown = SCENIC_AXES.map(
      (a) => `${a.key.slice(0, 4)} ${(axisTotals[a.key] / count).toFixed(2)}`,
    ).join("  ");

    console.log(
      `${ok ? "✓" : "✗"} ${lm.name.padEnd(32)} ${mean.toFixed(3)} ` +
        `(expected ${lo}–${hi}, ${count} edges)`,
    );
    console.log(`    ${breakdown}`);
    if (!ok) console.log(`    ↳ ${lm.note}`);
  }

  console.log(
    `\n${LANDMARKS.length - failures}/${LANDMARKS.length} in band` +
      (failures ? " — the heatmap disagrees with the city, fix the data first" : ""),
  );
  process.exit(failures ? 1 : 0);
}

main();
