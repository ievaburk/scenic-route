/**
 * The whole walkable network as GeoJSON, for the debug map.
 *
 * ~25 MB (~31 MB once scenic scores are attached), served straight to a
 * MapLibre source URL so the parse happens in the map's worker rather than on
 * the main thread. The ETag covers both artifacts: rebuild the graph *or*
 * re-score it and the browser refetches, otherwise reloads while panning
 * around cost a 304.
 */
import { graphGeoJSON, tryLoadGraph } from "@/lib/graph-server";
import { scoresFor } from "@/lib/scores-server";

export async function GET(request: Request) {
  const loaded = tryLoadGraph();
  if (!loaded) {
    return Response.json(
      { error: "No graph artifact. Run `npm run build:graph`." },
      { status: 503 },
    );
  }

  const status = scoresFor(loaded);
  const scores = status.state === "ok" ? status.scores : null;

  const etag = `W/"${loaded.etag.slice(3, -1)}-${scores?.meta.builtAt ?? "unscored"}"`;

  const headers = {
    "Content-Type": "application/geo+json",
    ETag: etag,
    // Revalidate every time, but let unchanged artifacts come back as a 304.
    "Cache-Control": "no-cache",
  };

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(graphGeoJSON(loaded, scores), { headers });
}
