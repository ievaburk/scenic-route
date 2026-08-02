/**
 * POST /api/interests/resolve — phrase → tag filter + a verified match count.
 *
 * PLAN.md §6. The count is the point: it's what turns "we accepted your text"
 * into "we found 1,046 of these near you", and §6 is explicit that verifying
 * against the real graph "is what stops the feature being a lie".
 *
 * Three outcomes, deliberately distinct:
 *   - resolved with a healthy count — say how many
 *   - resolved but thin, or never extracted — say which, and don't pretend
 *   - unresolved — say so plainly rather than creating a dead weight
 */
import { z } from "zod";
import { MAX_INTERESTS, resolveInterest, validateFilter } from "@/lib/interests";
import { interestLayer } from "@/lib/interest-layers";
import { tryLoadGraph } from "@/lib/graph-server";

const Body = z.object({
  phrases: z.array(z.string().min(1).max(80)).min(1).max(MAX_INTERESTS),
});

export async function POST(request: Request) {
  const loaded = tryLoadGraph();
  if (!loaded) {
    return Response.json(
      { error: "No graph artifact. Run `npm run build:graph`." },
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

  const results = parsed.phrases.map((phrase) => {
    const resolution = resolveInterest(phrase);

    if (resolution.status === "unresolved") {
      // §6: log these. The ranked list of what people typed and we couldn't
      // answer is the cheapest product research available.
      console.log(`[interest] unresolved: ${JSON.stringify(resolution.phrase)}`);
      return {
        phrase,
        status: "unresolved" as const,
        message:
          "Not something the map knows about. Plenty of things people love aren't in OpenStreetMap and never will be.",
      };
    }

    const check = validateFilter(resolution.entry.filter);
    if (!check.ok) {
      return { phrase, status: "invalid" as const, message: check.reason };
    }

    const layer = interestLayer(resolution.entry, loaded.graph);

    return {
      phrase,
      status: "resolved" as const,
      id: layer.id,
      label: layer.label,
      matchCount: layer.matchCount,
      edgesScored: layer.scores.size,
      coverage: layer.coverage,
      message:
        layer.coverage === "not-extracted"
          ? `We haven't extracted the data for ${layer.label.toLowerCase()} yet, so we genuinely don't know how many are near you.`
          : layer.coverage === "thin"
            ? `Only ${layer.matchCount} nearby. We'll route past them when it isn't a big detour, but it won't shape your walks much.`
            : `${layer.matchCount} nearby.`,
      caveat: layer.caveat,
    };
  });

  return Response.json({ interests: results });
}
