/**
 * Scenic scoring: the shape of the score artifact, and the pure functions that
 * decide what a number means. The pipeline that runs them over the whole graph
 * is `scripts/score-graph.ts`.
 *
 * Nothing here touches the filesystem — the debug map imports this too.
 */
import type { ScenicAxis } from "./features";
import { AXIS_KEYS } from "./features";

export type ScoreMeta = {
  builtAt: string;
  /**
   * The graph this was scored against. Scores are index-aligned with
   * `graph.edges`, so a rebuilt graph silently invalidates every index — this
   * is what lets the loader refuse to pair mismatched artifacts instead of
   * rendering a beautiful, wrong map.
   */
  graphBuiltAt: string;
  edges: number;
  /** Feature counts by source, so the debug panel can show what fed the score. */
  sources: Record<string, number>;
};

export type ScoreArtifact = {
  meta: ScoreMeta;
  /** Per axis, one percentile-normalised 0–1 value per edge, index-aligned with `graph.edges`. */
  axes: Record<ScenicAxis, number[]>;
};

/**
 * Distance decay, 1 at the feature and 0 at `reach`.
 *
 * Slightly convex (^1.5) rather than linear: being *at* the water is worth
 * noticeably more than being a block inland, and a linear ramp doesn't say
 * that strongly enough.
 */
export function decay(distanceM: number, reach: number): number {
  if (distanceM >= reach) return 0;
  if (distanceM <= 0) return 1;
  return (1 - distanceM / reach) ** 1.5;
}

/**
 * Squash a sum of feature contributions into 0–1.
 *
 * Needed because contributions genuinely add up — a block can have a park on
 * one side and twenty street trees along it — but "twice as many trees" is not
 * "twice as nice". Saturating keeps a dense-canopy street from outscoring
 * standing inside Prospect Park.
 */
export function saturate(sum: number): number {
  return 1 - Math.exp(-sum);
}

/**
 * The quiet axis, derived rather than tagged (PLAN.md §5).
 *
 * Nothing in OSM says "this street is peaceful", but road class is a strong
 * proxy for traffic volume, and lanes and speed limit refine it. This is the
 * one axis computed from the edge's own tags rather than from what's near it.
 *
 * Note for later: PLAN.md §11 flags that maximising quiet after dark is
 * maximising "nobody around". Night routing needs a lighting counterweight
 * before it ships — a correctness requirement, not a feature.
 */
export function quietScore(tags: Record<string, string>): number {
  const highway = tags.highway ?? "";

  let base: number;
  switch (highway) {
    case "pedestrian":
    case "living_street":
    case "footway":
    case "path":
    case "steps":
      base = 1;
      break;
    case "track":
      base = 0.9;
      break;
    case "cycleway":
      base = 0.8;
      break;
    case "residential":
      base = 0.65;
      break;
    case "service":
    case "unclassified":
      base = 0.6;
      break;
    case "tertiary":
    case "tertiary_link":
      base = 0.35;
      break;
    case "secondary":
    case "secondary_link":
      base = 0.2;
      break;
    case "primary":
    case "primary_link":
      base = 0.05;
      break;
    default:
      base = 0.5;
  }

  // A four-lane "residential" street is not residential in any way that
  // matters to someone walking down it.
  const lanes = Number(tags.lanes);
  if (Number.isFinite(lanes)) {
    if (lanes >= 4) base *= 0.6;
    else if (lanes === 3) base *= 0.8;
  }

  // maxspeed is "25 mph" in NYC far more often than a bare number.
  const speed = parseFloat(tags.maxspeed ?? "");
  if (Number.isFinite(speed) && speed >= 30) base *= 0.75;

  // A road closed to cars is quiet whatever its class says.
  if (tags.motor_vehicle === "no" || tags.vehicle === "no") base = Math.max(base, 0.9);

  return Math.min(1, base);
}

/**
 * Percentile-normalise raw scores across the whole city.
 *
 * The load-bearing decision from PLAN.md §7: normalising by *absolute* value
 * means a city with no river can never produce a water route, because every
 * edge scores near zero on an absolute scale. The question a walker is
 * actually asking is "is this watery relative to what this city offers".
 *
 * Two details that matter more than they look:
 *
 *   - **Zeros stay zero.** Ranking the whole population would hand an edge
 *     with no water anywhere near it a middling water percentile purely
 *     because most other edges have none either. Only edges with a non-zero
 *     raw score get ranked, and they're mapped into (0, 1].
 *   - **Ties share a rank.** `quiet` takes only a dozen distinct raw values, so
 *     assigning by sorted position would smear every residential street in the
 *     city across a wide range in arbitrary order. Equal inputs must produce
 *     equal outputs.
 */
export function percentileNormalise(raw: Float64Array): Float64Array {
  const n = raw.length;
  const out = new Float64Array(n);

  const nonZero: number[] = [];
  for (let i = 0; i < n; i++) if (raw[i] > 0) nonZero.push(i);
  if (nonZero.length === 0) return out;

  nonZero.sort((a, b) => raw[a] - raw[b]);

  const m = nonZero.length;
  let i = 0;
  while (i < m) {
    // Consume the whole run of equal values, then give them all the mean rank.
    let j = i;
    while (j + 1 < m && raw[nonZero[j + 1]] === raw[nonZero[i]]) j++;

    const meanRank = (i + j) / 2;
    // +1 keeps the lowest-ranked group just above 0, so "faintest signal in the
    // city" is at least representable as distinct from "no signal". Note that
    // over a graph this size the gap is ~1e-5 and the artifact serialises at
    // 3dp, so the bottom group does land back on 0 on disk. That's deliberate
    // and harmless — nothing downstream can act on the difference.
    const value = (meanRank + 1) / m;
    for (let k = i; k <= j; k++) out[nonZero[k]] = value;

    i = j + 1;
  }

  return out;
}

/**
 * The per-edge `scenic(e)` the router consumes: weighted composite, then
 * **percentile-normalised across the city a second time**.
 *
 * That second pass is not a tuning knob, it repairs a real gap. §7
 * percentile-normalises each axis so scores spread uniformly over [0,1] — and
 * then averaging six of them concentrates the result back around the middle,
 * because that is what averaging does. The uniformity is thrown away at the
 * last step: the median edge scored 0.233 and the 90th percentile 0.463.
 *
 * The consequence was that α could not do its job. At maximum greed a
 * 90th-percentile edge cost 0.58× its time against a median edge's 0.79× —
 * only 1.35× cheaper, nowhere near enough to repay a detour. The α search
 * saturated at its ceiling while spending 0.1 of the 10 minutes offered, so
 * §8's detour budget — the central mechanic of A-to-B — was inert.
 *
 * Re-ranking restores p50 = 0.5, p90 = 0.9 and a 2.90× discount ratio, and the
 * budget starts binding.
 *
 * One honest caveat, and it is the same one §11 raises about percentile
 * normalisation generally: this *guarantees* contrast rather than measuring it.
 * Exactly 10% of edges score ≥0.9 however uniformly dull the city is, so the
 * router always believes there is something worth detouring toward. Defensible
 * for a pilot — "nice relative to what this city offers" is the question a
 * walker is asking — but it is a stronger claim at the composite level than
 * per-axis, and it will need revisiting well before city #5.
 */
export function scenicArray(
  axes: Record<ScenicAxis, number[]>,
  count: number,
  weights: Record<ScenicAxis, number>,
): Float32Array {
  const raw = new Float64Array(count);
  for (let i = 0; i < count; i++) raw[i] = compositeScore(axes, i, weights);

  const ranked = percentileNormalise(raw);

  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = ranked[i];
  return out;
}

/**
 * Weighted mean of the axes for one edge — the raw ingredient of
 * `scenicArray` above, and exactly the blend PLAN.md §8 specifies.
 *
 * Linear is right *here* because at route time the weights are the user's own.
 * Someone who asked for water and green has zeros on the other four axes, so
 * the axes they don't care about can't dilute the ones they do.
 */
export function compositeScore(
  axes: Record<ScenicAxis, number[]>,
  edge: number,
  weights: Record<ScenicAxis, number>,
): number {
  let sum = 0;
  let total = 0;
  for (const axis of AXIS_KEYS) {
    const w = weights[axis] ?? 0;
    if (w === 0) continue;
    sum += w * (axes[axis][edge] ?? 0);
    total += w;
  }
  return total === 0 ? 0 : sum / total;
}

/**
 * "How interesting is this street, for any reason?" — the single number the
 * debug map colours by and the landmark check asserts on.
 *
 * A quadratic mean rather than an arithmetic one, and the difference is not
 * cosmetic. **The six axes are alternative reasons to like a street, not
 * additive components of one quantity.** Averaging them flat says the Hudson
 * River Greenway — 0.90 green, 0.94 water, and one of the genuinely great
 * walks in the city — is mediocre, because it has no monuments and no historic
 * district. That is the aggregator being wrong, not the data: a street is
 * allowed to be excellent for exactly one reason.
 *
 * Squaring before averaging lets a strong axis carry an edge while still
 * rewarding places that are good at several. On the pilot data it moves the
 * Greenway 0.42 → 0.58 and leaves 8th Avenue at 0.27.
 *
 * Deliberately *not* what routing uses — see `compositeScore` above for why the
 * distinction is real rather than two ways of saying the same thing.
 */
export function overallScore(
  axes: Record<ScenicAxis, number[]>,
  edge: number,
  weights: Record<ScenicAxis, number>,
): number {
  let sum = 0;
  let total = 0;
  for (const axis of AXIS_KEYS) {
    const w = weights[axis] ?? 0;
    if (w === 0) continue;
    const v = axes[axis][edge] ?? 0;
    sum += w * v * v;
    total += w;
  }
  return total === 0 ? 0 : Math.sqrt(sum / total);
}
