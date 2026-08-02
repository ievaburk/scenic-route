/**
 * Turning a request into three routes: the α binary search and the alternates.
 *
 * Implements PLAN.md §8. The search itself is in `lib/router.ts`; this is the
 * layer that decides *which* searches to run.
 */
import {
  findRoute,
  routeCost,
  summarise,
  type Route,
  type RoutingGraph,
  type SearchOptions,
  type SearchScratch,
} from "./router";

/** α must stay below 1 so edge costs stay positive and A* stays valid. */
export const MAX_ALPHA = 0.9;

/** Iterations of the α bisection. 8 lands within ~0.004 of the true frontier. */
const ALPHA_STEPS = 8;

/** Cost multiplier applied to an already-returned route's edges (PLAN.md §8). */
const ALTERNATE_PENALTY = 1.4;

/** A candidate sharing more than this much length with a kept route is rejected. */
const MAX_OVERLAP = 0.6;

export type PlannedRoute = Route & {
  /** The scenery greed this route was found at. */
  alpha: number;
  /** Seconds over the fastest route. 0 for the baseline. */
  detour: number;
};

export type PlanResult = {
  routes: PlannedRoute[];
  /** Seconds — the α=0 baseline every detour is measured against. */
  fastestTime: number;
  /**
   * Seconds for the fastest route ignoring via-points, when there are any.
   * `fastestTime − directTime` is what visiting them actually costs.
   */
  directTime?: number;
  /** The time budget the α search was held to. */
  budget: number;
  /** Largest α whose route still fits the budget. */
  alphaAtBudget: number;
  /** How many A* runs this took, for the debug panel. */
  searches: number;
};

/**
 * Largest α whose route still fits inside `budget` seconds.
 *
 * PLAN.md §8 is explicit that route time is monotone in α only *in
 * expectation*, not strictly — a slightly greedier α can occasionally find a
 * marginally quicker path. Bisection can therefore land a hair off the true
 * frontier. That's accepted: the alternative is a linear sweep at many times
 * the cost, to fix an error nobody walking the route could perceive.
 *
 * The best feasible route found along the way is kept rather than recomputed,
 * so the bisection costs exactly `ALPHA_STEPS` searches and no more.
 */
function searchAlpha(
  g: RoutingGraph,
  scratch: SearchScratch,
  waypoints: number[],
  scenic: Float32Array,
  budget: number,
  penalty?: Float32Array,
): { route: Route | null; alpha: number; searches: number } {
  let lo = 0;
  let hi = MAX_ALPHA;
  let best: Route | null = null;
  let bestAlpha = 0;
  let searches = 0;

  for (let i = 0; i < ALPHA_STEPS; i++) {
    const mid = (lo + hi) / 2;
    const route = findRouteThrough(g, scratch, waypoints, {
      scenic,
      alpha: mid,
      penalty,
    });
    searches++;

    if (route && route.time <= budget) {
      // Feasible — keep it and get greedier.
      best = route;
      bestAlpha = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return { route: best, alpha: bestAlpha, searches };
}

/**
 * One route through a sequence of waypoints, as consecutive A* legs.
 *
 * This is the answer to a request a per-edge discount structurally cannot
 * express. Folding scenery into the cost makes the search *prefer* nicer
 * streets among comparable options; it cannot make it walk a kilometre out of
 * the way to a specific place, because no discount on the edges you'd traverse
 * repays the ones you wouldn't. Asking for the Brooklyn Bridge Park piers is
 * not "score the waterfront higher" — it is "go there", and that is a
 * different instruction.
 *
 * Deliberately no penalty on edges already used by earlier legs. PLAN.md §9
 * applies one for loop mode, but a via-point is often a dead end — a pier
 * ends at the water — so forbidding the way back would either fail or return
 * something contorted. Walking out and back along a pier is what visiting a
 * pier *is*.
 */
export function findRouteThrough(
  g: RoutingGraph,
  scratch: SearchScratch,
  waypoints: number[],
  opts: SearchOptions,
): Route | null {
  if (waypoints.length < 2) return null;

  const nodes: number[] = [];
  const edges: number[] = [];

  for (let i = 0; i < waypoints.length - 1; i++) {
    const leg = findRoute(g, scratch, waypoints[i], waypoints[i + 1], opts);
    if (!leg) return null;

    // Drop the shared waypoint so it isn't counted twice.
    nodes.push(...(i === 0 ? leg.nodes : leg.nodes.slice(1)));
    edges.push(...leg.edges);
  }

  return summarise(g, opts.scenic, nodes, edges);
}

/**
 * Is this candidate worse than something already kept on *both* counts?
 *
 * Three options only help if each one wins at something. A route that is
 * slower than one already on the list and no more scenic is strictly dominated
 * — there is no walker for whom it's the right answer, and offering it makes
 * the other two harder to compare. This mostly catches penalised alternates,
 * which get pushed off the good edges by construction and can come back worse
 * in every respect.
 */
function isDominated(candidate: Route, kept: PlannedRoute[]): boolean {
  return kept.some(
    (k) => k.time <= candidate.time && k.scenic >= candidate.scenic,
  );
}

/** Fraction of `candidate`'s length that reuses edges from `existing`. */
export function overlapFraction(
  g: RoutingGraph,
  candidate: Route,
  existing: Route[],
): number {
  if (candidate.len === 0) return 0;
  const used = new Set<number>();
  for (const r of existing) for (const e of r.edges) used.add(e);

  let shared = 0;
  for (const e of candidate.edges) if (used.has(e)) shared += g.len[e];
  return shared / candidate.len;
}

export type PlanOptions = {
  source: number;
  target: number;
  /** Node indices the route must pass through, in order. */
  via?: number[];
  scenic: Float32Array;
  /** Extra minutes the walker is willing to spend, over the fastest route. */
  slackMin: number;
};

/**
 * Three routes spanning the trade-off, per PLAN.md §8 step 3.
 *
 * Not three near-optima of one objective — that's the failure mode the plan
 * calls out. The three are: the fastest route (α=0, the baseline the detour is
 * measured against), the greediest route the budget allows, and one at roughly
 * half that greed. The user sees the trade-off as three real options rather
 * than a number they have to trust.
 *
 * Where a candidate would duplicate one already kept, its predecessors' edges
 * are inflated by `ALTERNATE_PENALTY` and it's searched again — the standard
 * penalty method. Anything still overlapping more than `MAX_OVERLAP` is
 * dropped rather than padded out, because three nearly identical lines is a
 * worse answer than two distinct ones.
 */
export function planRoutes(
  g: RoutingGraph,
  scratch: SearchScratch,
  opts: PlanOptions,
): PlanResult | null {
  const { source, target, via, scenic, slackMin } = opts;
  const waypoints = [source, ...(via ?? []), target];

  // 1. Fastest route sets the baseline and the budget.
  //
  //    With via-points that baseline is the fastest route *through them*, not
  //    the fastest way to the destination. The user has already decided they're
  //    going to the piers; the slack they're offering is for scenery on top of
  //    that, and measuring the detour against a route they've rejected would
  //    make every "+N minutes" figure meaningless. `directTime` reports the
  //    unconstrained cost separately so the true price of the via is still
  //    visible.
  const fastest = findRouteThrough(g, scratch, waypoints, { scenic, alpha: 0 });
  if (!fastest) return null;
  let searches = 1;

  let directTime: number | undefined;
  if (via?.length) {
    const direct = findRoute(g, scratch, source, target, { scenic, alpha: 0 });
    searches++;
    directTime = direct?.time;
  }

  const budget = fastest.time + slackMin * 60;

  // 2. Greediest α that still fits.
  const atBudget = searchAlpha(g, scratch, waypoints, scenic, budget);
  searches += atBudget.searches;

  // 3. A middle option, so the trade-off reads as a spectrum rather than a
  //    binary. Half the greed, not half the detour — α is the dial we have.
  const midAlpha = atBudget.alpha / 2;
  const mid =
    midAlpha > 0
      ? findRouteThrough(g, scratch, waypoints, { scenic, alpha: midAlpha })
      : null;
  if (mid) searches++;

  // 4. The fastest route is kept verbatim and never penalised. PLAN.md §8
  //    makes it the baseline the detour is measured against, so a "fastest"
  //    that had been pushed off its own optimum to look different from the
  //    scenic options would make every +N minutes figure a lie.
  const kept: PlannedRoute[] = [
    { ...fastest, alpha: 0, detour: 0 },
  ];

  const candidates: { route: Route; alpha: number }[] = [];
  if (atBudget.route) candidates.push({ route: atBudget.route, alpha: atBudget.alpha });
  if (mid) candidates.push({ route: mid, alpha: midAlpha });

  // Scenic-first, so if two collide the more interesting one survives intact.
  const penalty = new Float32Array(g.edgeCount).fill(1);

  for (const candidate of candidates) {
    let route = candidate.route;

    if (overlapFraction(g, route, kept) > MAX_OVERLAP) {
      // Push the search away from what's already been returned.
      for (const r of kept) {
        for (const e of r.edges) penalty[e] = ALTERNATE_PENALTY;
      }
      const retry = findRouteThrough(g, scratch, waypoints, {
        scenic,
        alpha: candidate.alpha,
        penalty,
      });
      searches++;
      penalty.fill(1);

      // Only accept the detoured version if it's distinct, still within
      // budget, and not dominated — an alternate that blows the budget isn't
      // an option the user asked for.
      if (
        retry &&
        retry.time <= budget &&
        overlapFraction(g, retry, kept) <= MAX_OVERLAP &&
        !isDominated(retry, kept)
      ) {
        route = retry;
      } else {
        continue;
      }
    }

    // The un-penalised candidates need the same test. The α sweep can return a
    // greedier route that is genuinely worse on both counts, because α trades
    // *cost* for scenery and cost is not time — a high-α route can wander onto
    // slow edges (steps, say) whose scenic score doesn't repay the minutes.
    if (isDominated(route, kept)) continue;

    kept.push({
      ...route,
      alpha: candidate.alpha,
      detour: route.time - fastest.time,
    });
  }

  // Present fastest-first — it's the baseline the other two are read against.
  kept.sort((a, b) => a.time - b.time);

  return {
    routes: kept,
    fastestTime: fastest.time,
    directTime,
    budget,
    alphaAtBudget: atBudget.alpha,
    searches,
  };
}

/** Re-export so callers don't need both modules for the common case. */
export { routeCost };
