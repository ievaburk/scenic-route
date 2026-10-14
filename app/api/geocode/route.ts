/**
 * POST /api/geocode — an address the walker typed → points they can route from.
 *
 * Server-side rather than calling Nominatim from the browser, for three
 * reasons: the User-Agent their policy requires is ours to set, the in-process
 * cache and the 1/sec limiter only work if every request funnels through one
 * place, and it keeps the walker's IP out of a third party's logs.
 */
import { z } from "zod";
import { geocode } from "@/lib/geocode";

const Body = z.object({ q: z.string().min(2).max(120) });

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = Body.parse(await request.json());
  } catch (err) {
    return Response.json(
      { error: "Invalid request", detail: (err as Error).message },
      { status: 400 },
    );
  }

  try {
    const result = await geocode(parsed.q);

    // The three outcomes stay distinct all the way to the UI, same as the
    // interest resolver: found, real-but-outside-our-map, and no such place.
    // Collapsing the middle one into "not found" tells a walker in Queens that
    // their own address doesn't exist.
    if (result.status === "out-of-area") {
      return Response.json({
        status: "out-of-area",
        message: `We only cover Manhattan below 125th and brownstone Brooklyn so far — ${result.nearest} is outside that.`,
      });
    }

    if (result.status === "not-found") {
      return Response.json({
        status: "not-found",
        message: "No address like that around here. Try adding the street number or neighbourhood.",
      });
    }

    return Response.json({ status: "ok", places: result.places });
  } catch (err) {
    // Nominatim being slow or rate-limiting us is not the walker's problem, and
    // tapping the map still works — say so rather than failing silently.
    return Response.json(
      {
        error: "Address lookup is unavailable right now — tap the map instead.",
        detail: (err as Error).message,
      },
      { status: 502 },
    );
  }
}
