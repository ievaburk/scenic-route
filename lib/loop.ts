/**
 * Loop mode: "walk me for N minutes from here, and back here again."
 *
 * PLAN.md §9, and the wedge from §3 — the request Google Maps cannot express,
 * because it has no input field for it and no concept that would satisfy it.
 *
 * No shortest-path formulation applies. "Loop of length L maximising scenery"
 * is an orienteering problem, so this is heuristic construction, which §9 is
 * comfortable with because the objective is soft: there is no correct answer to
 * be wrong about, only a walk that's nice or isn't.
 *
 * The duration budget replaces the detour budget entirely here, which is
 * exactly why loop mode is the easier wedge — §8's whole α-vs-budget
 * apparatus, and its awkward finding that α saturates before the budget binds,
 * simply doesn't arise. The time *is* the request.
 */
import {
  findRoute,
  summarise,
  type Route,
  type RoutingGraph,
  type SearchScratch,
} from "./router";
import { WALK_SPEED_MPS } from "./pilot";

/** Bearings sampled from the origin (§9 says 8–12). */
const BEARINGS = 10;

/** Anchors sit in this band around the ideal radius. */
const ANNULUS = [0.8, 1.3] as const;

/** Second anchor sits roughly this far round from the first. */
const SECOND_ANCHOR_DEG = 120;

/** Return legs pay this much for edges the loop has already used (§9 step 3). */
const REUSE_PENALTY = 2.0;

/** A loop reusing more than this share of its length is an out-and-back. */
const MAX_OVERLAP = 0.3;

/** Two loops sharing more than this aren't two options. */
const MAX_SIMILARITY = 0.6;

/** §9 step 4: land within ±10% of what was asked for. */
const DURATION_TOLERANCE = 0.1;

/**
 * Radius search bounds and effort, as multiples of the ideal circle radius.
 *
 * §9 step 4 says "trim or extend anchors to land within ±10%", and a fixed
 * ladder of scale factors isn't enough: it left a 20-minute request at Brooklyn
 * Heights returning 36 minutes. Loop length rises monotonically enough with
 * anchor distance to bisect on, so this does. The upper bound is generous
 * because coastal origins lose half their annulus to water and need to reach
 * further inland to make the distance up.
 */
const RADIUS_BOUNDS: [number, number] = [0.45, 2.2];
const RADIUS_ITERATIONS = 6;

/** Scenery greed for loops. Fixed rather than searched — see the note below. */
const LOOP_ALPHA = 0.7;

export type Loop = Route & {
  /** Share of the loop's length walked more than once, 0–1. */
  overlap: number;
  /** Scenic value per kilometre — how loops are ranked. */
  scenicPerKm: number;
  /** The two anchor nodes it was built around, for debugging. */
  anchors: [number, number];
};

export type LoopOptions = {
  origin: number;
  /** What the walker asked for. */
  durationMin: number;
  scenic: Float32Array;
  /**
   * Sparse per-interest edge scores. These bias *anchor selection*, not just
   * the edge costs — §9 is explicit that a bridge obsessive's loops should be
   * built around bridges rather than passing one by luck, and that only happens
   * if interests influence where the loop is aimed.
   */
  interestScores?: Map<number, number>[];
  /** How many to return. */
  count?: number;
};

export type LoopResult = {
  loops: Loop[];
  targetSeconds: number;
  /** Candidates built before filtering, for the debug panel. */
  considered: number;
  searches: number;
};

/**
 * Mean scenic value of the edges touching each node, plus any interest bonus.
 *
 * This is the "scenic density" §9 samples anchors by. Computed over the whole
 * graph once per request: 116k nodes at average degree ~3 is well under a
 * millisecond, and it's what lets anchor choice see the same landscape the
 * router will.
 */
function nodeDensity(
  g: RoutingGraph,
  scenic: Float32Array,
  interestScores: Map<number, number>[],
): Float64Array {
  const density = new Float64Array(g.nodeCount);

  for (let n = 0; n < g.nodeCount; n++) {
    const start = g.offsets[n];
    const end = g.offsets[n + 1];
    if (end === start) continue;

    let total = 0;
    for (let i = start; i < end; i++) {
      const e = g.adjEdge[i];
      let v = scenic[e];
      // Interests count for more here than they do in edge cost: an anchor is
      // a decision about where the whole walk goes, so a cluster of bridges
      // should visibly out-pull a marginally greener street.
      for (const layer of interestScores) v += (layer.get(e) ?? 0) * 1.5;
      total += v;
    }
    density[n] = total / (end - start);
  }

  return density;
}

/** Share of a route's length covered by edges it uses more than once. */
export function overlapOf(g: RoutingGraph, route: Route): number {
  if (route.len === 0) return 0;
  const counts = new Map<number, number>();
  for (const e of route.edges) counts.set(e, (counts.get(e) ?? 0) + 1);

  let repeated = 0;
  for (const [e, n] of counts) if (n > 1) repeated += g.len[e] * (n - 1);
  return repeated / route.len;
}

/** Did this loop land within §9's ±10% of what was asked for? */
function inTolerance(loop: Loop, targetSeconds: number): boolean {
  return Math.abs(loop.time - targetSeconds) / targetSeconds <= DURATION_TOLERANCE;
}

/** Share of `a`'s length that also appears in `b`. */
function similarity(g: RoutingGraph, a: Route, b: Route): number {
  if (a.len === 0) return 0;
  const inB = new Set(b.edges);
  let shared = 0;
  for (const e of a.edges) if (inB.has(e)) shared += g.len[e];
  return shared / a.len;
}

/**
 * Build one loop through two anchors, penalising edges as they're used.
 *
 * The penalty is applied *between* legs rather than once at the start, which is
 * what stops the walk doubling back: by the time the return leg is planned, the
 * outbound edges already cost double, so an alternative street of similar
 * quality wins.
 */
function buildLoop(
  g: RoutingGraph,
  scratch: SearchScratch,
  origin: number,
  a: number,
  b: number,
  scenic: Float32Array,
  penalty: Float32Array,
): { route: Route; searches: number } | null {
  penalty.fill(1);
  const nodes: number[] = [];
  const edges: number[] = [];
  let searches = 0;

  for (const [from, to] of [
    [origin, a],
    [a, b],
    [b, origin],
  ] as const) {
    const leg = findRoute(g, scratch, from, to, { scenic, alpha: LOOP_ALPHA, penalty });
    searches++;
    if (!leg) return null;

    nodes.push(...(nodes.length === 0 ? leg.nodes : leg.nodes.slice(1)));
    edges.push(...leg.edges);
    for (const e of leg.edges) penalty[e] = REUSE_PENALTY;
  }

  return { route: summarise(g, scenic, nodes, edges), searches };
}

/**
 * Three loops of roughly the requested duration, starting and ending here.
 *
 * α is fixed at 0.7 rather than binary-searched. In A-to-B, α trades scenery
 * against a time budget that the user set as a *ceiling*; here the duration is
 * the target itself, and the radius adjustment below is what hits it. Searching
 * α as well would be two knobs fighting over one constraint.
 */
export function planLoops(
  g: RoutingGraph,
  scratch: SearchScratch,
  opts: LoopOptions,
): LoopResult {
  const { origin, durationMin, scenic, interestScores = [], count = 3 } = opts;

  const targetSeconds = durationMin * 60;
  const targetMetres = targetSeconds * WALK_SPEED_MPS;
  const baseRadius = targetMetres / (2 * Math.PI);

  const density = nodeDensity(g, scenic, interestScores);
  const penalty = new Float32Array(g.edgeCount).fill(1);

  const ox = g.x[origin];
  const oy = g.y[origin];

  /** Best-density node in the annulus around `radius`, near `bearingDeg`. */
  const anchorAt = (bearingDeg: number, radius: number): number => {
    const target = (bearingDeg * Math.PI) / 180;
    const inner = radius * ANNULUS[0];
    const outer = radius * ANNULUS[1];
    // Wide enough to find something, narrow enough that twelve bearings give
    // twelve genuinely different directions.
    const halfWidth = Math.PI / BEARINGS;

    let best = -1;
    let bestScore = -Infinity;

    for (let n = 0; n < g.nodeCount; n++) {
      const dx = g.x[n] - ox;
      const dy = g.y[n] - oy;
      const d = Math.hypot(dx, dy);
      if (d < inner || d > outer) continue;

      let delta = Math.atan2(dx, dy) - target;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      if (Math.abs(delta) > halfWidth) continue;

      if (density[n] > bestScore) {
        bestScore = density[n];
        best = n;
      }
    }
    return best;
  };

  /**
   * Loops that hit the requested duration, and loops that didn't.
   *
   * Kept apart because duration *is* the request here — §9's whole point is
   * that the time budget replaces the detour budget. Ranking everything
   * together by scenery let a 36-minute loop beat a 22-minute one when the
   * walker asked for 20, which is the one mistake loop mode cannot make.
   * Near-misses are only used to pad the list out, and the UI always shows the
   * real duration.
   */
  const onTarget: Loop[] = [];
  const misses: Loop[] = [];
  let searches = 0;
  let considered = 0;

  for (let i = 0; i < BEARINGS; i++) {
    const bearing = (360 / BEARINGS) * i;

    // §9 step 4: bisect the anchor radius until the walk lands in tolerance.
    let lo = RADIUS_BOUNDS[0];
    let hi = RADIUS_BOUNDS[1];
    let best: Loop | null = null;
    let bestError = Infinity;

    for (let iter = 0; iter < RADIUS_ITERATIONS; iter++) {
      const scale = (lo + hi) / 2;
      const radius = baseRadius * scale;
      const a = anchorAt(bearing, radius);
      const b = anchorAt(bearing + SECOND_ANCHOR_DEG, radius);
      if (a < 0 || b < 0 || a === origin || b === origin || a === b) {
        // Nothing routable out there — the annulus is probably in the river.
        hi = scale;
        continue;
      }

      const built = buildLoop(g, scratch, origin, a, b, scenic, penalty);
      searches += built?.searches ?? 0;
      if (!built) {
        hi = scale;
        continue;
      }
      considered++;

      const loop: Loop = {
        ...built.route,
        overlap: overlapOf(g, built.route),
        scenicPerKm: built.route.len > 0 ? built.route.scenic : 0,
        anchors: [a, b],
      };

      const error = Math.abs(loop.time - targetSeconds) / targetSeconds;
      if (error < bestError) {
        bestError = error;
        best = loop;
      }
      if (error <= DURATION_TOLERANCE) break;

      // Too short means reach further out; too long means pull in.
      if (loop.time < targetSeconds) lo = scale;
      else hi = scale;
    }

    if (best && best.overlap <= MAX_OVERLAP) {
      inTolerance(best, targetSeconds) ? onTarget.push(best) : misses.push(best);
    }
  }

  // Rank by scenery per kilometre (§9 step 5) *within* the loops that are the
  // right length, then fall back to the closest misses only to fill the list.
  onTarget.sort((a, b) => b.scenicPerKm - a.scenicPerKm);
  misses.sort(
    (a, b) =>
      Math.abs(a.time - targetSeconds) - Math.abs(b.time - targetSeconds),
  );

  const loops: Loop[] = [];
  for (const candidate of [...onTarget, ...misses]) {
    if (loops.length >= count) break;
    if (loops.some((k) => similarity(g, candidate, k) > MAX_SIMILARITY)) continue;
    loops.push(candidate);
  }

  return { loops, targetSeconds, considered, searches };
}
