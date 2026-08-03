/**
 * POST /api/loop — "walk me for N minutes from here, and back here again."
 *
 * PLAN.md §9. The wedge from §3: Google Maps cannot express this request, which
 * is why it's the first user-facing surface rather than A-to-B.
 *
 * Note what's *absent* compared to /api/route — there is no slack, no detour
 * budget, no α search. The duration is the request, not a constraint on one.
 */
import { z } from "zod";
import { AXIS_KEYS, DEFAULT_WEIGHTS, type ScenicAxis } from "@/lib/features";
import { MAX_INTERESTS, resolveInterest, validateFilter } from "@/lib/interests";
import { applyInterests, interestLayer, type InterestLayer } from "@/lib/interest-layers";
import { planLoops } from "@/lib/loop";
import { nearestNode, scenicFor, tryLoadRouting } from "@/lib/router-server";

const Body = z.object({
  origin: z.object({
    lon: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
  }),
  /** 20/40/60 are the picker defaults; the range is what's plausible on foot. */
  durationMin: z.number().min(10).max(180).default(40),
  weights: z
    .record(z.enum(AXIS_KEYS as [ScenicAxis, ...ScenicAxis[]]), z.number().min(0).max(1))
    .optional(),
  interests: z.array(z.string().min(1).max(80)).max(MAX_INTERESTS).optional(),
  interestWeight: z.number().min(0).max(1).default(0.6),
  /**
   * Changes which loops come back for the same request — §4's "regenerate /
   * something else", which it calls critical for loop mode. Rotating the
   * bearing sweep is enough to land on a different set.
   */
  seed: z.number().int().min(0).max(999).default(0),
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
  const core = scenicFor(ctx.scores, weights);

  const resolved: { layer: InterestLayer; weight: number }[] = [];
  const interestReport = (parsed.interests ?? []).map((phrase) => {
    const r = resolveInterest(phrase);
    if (r.status === "unresolved") return { phrase, status: "unresolved" as const };
    if (!validateFilter(r.entry.filter).ok) return { phrase, status: "invalid" as const };
    const layer = interestLayer(r.entry, ctx.artifact);
    if (layer.scores.size > 0) resolved.push({ layer, weight: parsed.interestWeight });
    return {
      phrase, status: "resolved" as const, id: layer.id, label: layer.label,
      matchCount: layer.matchCount, coverage: layer.coverage,
    };
  });

  const scenic = applyInterests(core, resolved);
  const origin = nearestNode(ctx.graph, ctx.artifact, parsed.origin.lon, parsed.origin.lat);

  const started = performance.now();
  const result = planLoops(ctx.graph, ctx.scratch, {
    origin,
    durationMin: parsed.durationMin,
    scenic,
    // Anchors, not just edge costs — see the note in lib/loop.ts.
    interestScores: resolved.map((r) => r.layer.scores),
    seed: parsed.seed,
  });
  const ms = performance.now() - started;

  if (result.loops.length === 0) {
    return Response.json(
      { error: "Couldn't find a loop from there. Try a different starting point." },
      { status: 422 },
    );
  }

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
      durationMin: parsed.durationMin,
      weights,
      interests: interestReport,
      seed: parsed.seed,
    },
    meta: {
      targetSeconds: result.targetSeconds,
      considered: result.considered,
      searches: result.searches,
      ms: Math.round(ms * 10) / 10,
      snapped: {
        lon: ctx.artifact.nodes.lon[origin],
        lat: ctx.artifact.nodes.lat[origin],
      },
    },
    loops: result.loops.map((loop, i) => ({
      id: i,
      time: Math.round(loop.time),
      onTarget: loop.onTarget,
      len: Math.round(loop.len),
      scenic: Math.round(loop.scenic * 1000) / 1000,
      overlap: Math.round(loop.overlap * 1000) / 1000,
      axes: axisExposure(loop.edges, loop.len),
      interests: resolved.map(({ layer }) => ({
        id: layer.id,
        label: layer.label,
        metres: Math.round(
          loop.edges.reduce((m, e) => m + (layer.scores.has(e) ? ctx.graph.len[e] : 0), 0),
        ),
      })),
      geometry: {
        type: "LineString" as const,
        coordinates: loopCoordinates(ctx.artifact, loop.edges, loop.nodes),
      },
    })),
  });
}

/**
 * Stitch edge geometries in travel order.
 *
 * Each edge stores its polyline in its own direction, which is not necessarily
 * the direction of travel, so it's flipped when we didn't enter from its stored
 * start. On a loop this matters more than on an A-to-B route: the same edge can
 * legitimately appear twice, in opposite directions.
 */
function loopCoordinates(
  artifact: { edges: { a: number; geom: number[] }[] },
  edges: number[],
  nodes: number[],
): [number, number][] {
  const coords: [number, number][] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = artifact.edges[edges[i]];
    const points: [number, number][] = [];
    for (let j = 0; j < e.geom.length; j += 2) points.push([e.geom[j], e.geom[j + 1]]);
    if (e.a !== nodes[i]) points.reverse();
    coords.push(...(i === 0 ? points : points.slice(1)));
  }
  return coords;
}
