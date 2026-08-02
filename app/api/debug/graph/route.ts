/**
 * The whole walkable network as GeoJSON, for the debug map.
 *
 * ~25 MB, served straight to a MapLibre source URL so the parse happens in the
 * map's worker rather than on the main thread. The ETag is derived from the
 * artifact's build timestamp: rebuild the graph and the browser refetches,
 * otherwise reloads while panning around cost a 304.
 */
import { graphGeoJSON, tryLoadGraph } from "@/lib/graph-server";

export async function GET(request: Request) {
  const loaded = tryLoadGraph();
  if (!loaded) {
    return Response.json(
      { error: "No graph artifact. Run `npm run build:graph`." },
      { status: 503 },
    );
  }

  const headers = {
    "Content-Type": "application/geo+json",
    ETag: loaded.etag,
    // Revalidate every time, but let an unchanged graph come back as a 304.
    "Cache-Control": "no-cache",
  };

  if (request.headers.get("if-none-match") === loaded.etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(graphGeoJSON(loaded), { headers });
}
