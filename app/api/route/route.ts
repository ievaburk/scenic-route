/**
 * POST /api/route — origin + destination → three scored routes as GeoJSON.
 *
 * PLAN.md §7. Loop mode (`mode: 'loop'`) arrives in Phase 4; this handler is
 * A-to-B only, which §12 is explicit is an *internal* tool at this stage — the
 * engine gets built through A-to-B, and loop mode is the first surface users
 * actually see.
 */
import { z } from "zod";
import { AXIS_KEYS, DEFAULT_WEIGHTS, type ScenicAxis } from "@/lib/features";
import { planRoutes } from "@/lib/plan-route";
import { nearestNode, scenicFor, tryLoadRouting } from "@/lib/router-server";

const Point = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});

const Body = z.object({
  origin: Point,
  destination: Point,
  /**
   * Places the walk must pass through, in order. This is how "take me past the
   * piers" is expressed — the scenic discount can prefer nicer streets among
   * comparable options but cannot make the search detour to a named place.
   * Capped because each one adds a leg to every search in the α sweep.
   */
  via: z.array(Point).max(5).optional(),
  /** Extra minutes over the fastest route the walker will spend. */
  slackMin: z.number().min(0).max(120).default(10),
  /** Per-axis weights, 0–1. Omitted axes fall back to the default of 1. */
  weights: z.record(z.enum(AXIS_KEYS as [ScenicAxis, ...ScenicAxis[]]), z.number().min(0).max(1)).optional(),
});

export async function POST(request: Request) {
  const ctx = tryLoadRouting();
  if (!ctx) {
    return Response.json(
      {
        error:
          "Routing needs both data/graph.json and a matching data/scores.json. " +
          "Run `npm run build:graph && npm run score:graph`.",
      },
      { status: 503 },
    );
  }

  let parsed;
  try {
    parsed = Body.parse(await request.json());
  } catch (err) {
    return Response.json(
      { error: "Invalid request", detail: (err as Error).message },
      { status: 400 },
    );
  }

  const weights = { ...DEFAULT_WEIGHTS, ...(parsed.weights ?? {}) };
  const scenic = scenicFor(ctx.scores, weights);

  const source = nearestNode(
    ctx.graph, ctx.artifact, parsed.origin.lon, parsed.origin.lat,
  );
  const target = nearestNode(
    ctx.graph, ctx.artifact, parsed.destination.lon, parsed.destination.lat,
  );
  const via = (parsed.via ?? []).map((p) =>
    nearestNode(ctx.graph, ctx.artifact, p.lon, p.lat),
  );

  const started = performance.now();
  const plan = planRoutes(ctx.graph, ctx.scratch, {
    source,
    target,
    via,
    scenic,
    slackMin: parsed.slackMin,
  });
  const ms = performance.now() - started;

  if (!plan) {
    return Response.json(
      { error: "No walking route between those points" },
      { status: 422 },
    );
  }

  // Per-axis exposure makes the breakdown card possible — "1.1 km along the
  // water" is this number times the route length (PLAN.md §4).
  const axisExposure = (edges: number[], len: number) => {
    const out = {} as Record<ScenicAxis, number>;
    for (const axis of AXIS_KEYS) {
      let metres = 0;
      for (const e of edges) metres += (ctx.scores.axes[axis][e] ?? 0) * ctx.graph.len[e];
      out[axis] = len > 0 ? metres / len : 0;
    }
    return out;
  };

  return Response.json({
    query: {
      origin: parsed.origin,
      destination: parsed.destination,
      slackMin: parsed.slackMin,
      weights,
    },
    meta: {
      fastestTime: plan.fastestTime,
      // Present only with via-points: what the walk would have cost without
      // them, so the price of the detour stays visible.
      directTime: plan.directTime,
      viaCost:
        plan.directTime !== undefined
          ? Math.round(plan.fastestTime - plan.directTime)
          : undefined,
      budget: plan.budget,
      alphaAtBudget: plan.alphaAtBudget,
      searches: plan.searches,
      ms: Math.round(ms * 10) / 10,
      snapped: {
        origin: { lon: ctx.artifact.nodes.lon[source], lat: ctx.artifact.nodes.lat[source] },
        destination: { lon: ctx.artifact.nodes.lon[target], lat: ctx.artifact.nodes.lat[target] },
      },
    },
    routes: plan.routes.map((r, i) => ({
      id: i,
      alpha: Math.round(r.alpha * 1000) / 1000,
      time: Math.round(r.time),
      detour: Math.round(r.detour),
      len: Math.round(r.len),
      scenic: Math.round(r.scenic * 1000) / 1000,
      axes: axisExposure(r.edges, r.len),
      geometry: {
        type: "LineString" as const,
        coordinates: routeCoordinates(ctx.artifact, r.edges, r.nodes),
      },
    })),
  });
}

/**
 * Stitch the route's edge geometries into one line.
 *
 * Each edge stores its own polyline in its own direction, which is not
 * necessarily the direction of travel — the graph is undirected. So each edge's
 * geometry is flipped when its stored start doesn't match the node we arrived
 * from, otherwise the drawn line zig-zags back and forth along every segment.
 */
function routeCoordinates(
  artifact: { edges: { a: number; geom: number[] }[] },
  edges: number[],
  nodes: number[],
): [number, number][] {
  const coords: [number, number][] = [];

  for (let i = 0; i < edges.length; i++) {
    const e = artifact.edges[edges[i]];
    const forward = e.a === nodes[i];

    const points: [number, number][] = [];
    for (let j = 0; j < e.geom.length; j += 2) {
      points.push([e.geom[j], e.geom[j + 1]]);
    }
    if (!forward) points.reverse();

    // Drop the shared junction so it isn't emitted twice.
    coords.push(...(i === 0 ? points : points.slice(1)));
  }

  return coords;
}
