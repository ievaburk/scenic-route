/**
 * The raw OSM tag set behind a clicked edge.
 *
 * Kept out of the GeoJSON deliberately: full tags on 170k features would
 * multiply the payload, and only the edge you clicked needs them. Retaining
 * the complete tag set is load-bearing for free-text interests (PLAN.md §6),
 * so the debug map shows all of it rather than a curated subset.
 */
import { tryLoadGraph } from "@/lib/graph-server";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ i: string }> },
) {
  const loaded = tryLoadGraph();
  if (!loaded) {
    return Response.json(
      { error: "No graph artifact. Run `npm run build:graph`." },
      { status: 503 },
    );
  }

  const { i } = await ctx.params;
  const index = Number(i);
  const tags = Number.isInteger(index) ? loaded.graph.tagSets[index] : undefined;
  if (!tags) {
    return Response.json({ error: `No tag set ${i}` }, { status: 404 });
  }

  return Response.json(tags);
}
