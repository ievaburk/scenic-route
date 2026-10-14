/**
 * Address → coordinates, via Nominatim.
 *
 * Same data lineage as everything else here (OSM, ODbL, already attributed), no
 * API key, and it agrees with the graph we route on — a geocoder from a
 * different source would happily return a point on a street our extract doesn't
 * contain.
 *
 * Nominatim's usage policy is stricter than Overpass's and is the reason for
 * most of the shape of this file:
 *
 *   - **A real User-Agent is required.** Same lesson Overpass taught (it 406s on
 *     undici's default); Nominatim blocks rather than fails loudly.
 *   - **One request per second, absolute maximum.** Enforced here as a promise
 *     chain so concurrent callers queue rather than burst.
 *   - **No autocomplete.** Firing a query per keystroke is explicitly
 *     prohibited, which is why the UI searches on submit and nothing here is
 *     designed for type-ahead latency.
 *
 * Results are cached in-process. A prototype re-searching "Union Square" twenty
 * times shouldn't spend twenty requests against a free service.
 */
import { PILOT } from "./pilot";

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "scenic-route/0.1 (walking-route prototype)";

/** Policy is 1/sec; a little over, because their clock isn't ours. */
const MIN_GAP_MS = 1100;

export type Place = {
  /** What to show in the results list. */
  label: string;
  lon: number;
  lat: number;
};

export type GeocodeResult =
  /** Found, and inside the area we can actually route. */
  | { status: "ok"; places: Place[] }
  /**
   * Real place, wrong city — distinguished from "no such place" deliberately.
   * Telling someone their address doesn't exist when the truth is that we only
   * cover part of New York is the same failure the interest resolver avoids by
   * separating "we haven't got that data" from "not a thing".
   */
  | { status: "out-of-area"; nearest: string }
  | { status: "not-found" };

const cache = new Map<string, GeocodeResult>();

/** Serialises outbound requests so the 1/sec limit holds across callers. */
let queue: Promise<unknown> = Promise.resolve();
let lastAt = 0;

function schedule<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastAt + MIN_GAP_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return job();
  });
  // Keep the chain alive even when a job throws, or one failure wedges it.
  queue = run.catch(() => {});
  return run;
}

type NominatimRow = { display_name?: string; name?: string; lon: string; lat: string };

async function query(params: Record<string, string>): Promise<NominatimRow[]> {
  const url = `${ENDPOINT}?${new URLSearchParams({
    format: "jsonv2",
    limit: "5",
    ...params,
  })}`;

  const res = await schedule(() =>
    fetch(url, { headers: { "User-Agent": USER_AGENT } }),
  );
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  return (await res.json()) as NominatimRow[];
}

/** Trim Nominatim's full display_name to something readable in a narrow panel. */
function shorten(row: NominatimRow, parts = 3): string {
  const full = row.display_name ?? row.name ?? "";
  const segments = full.split(",").map((p) => p.trim());
  // "351 W 42nd St, Hell's Kitchen, Manhattan, New York, 10036, United States"
  // → "351 W 42nd St, Hell's Kitchen, Manhattan". The country and postcode are
  // noise when every result is in one city by construction.
  return segments.slice(0, parts).join(", ") || full;
}

/**
 * Make every label in the list distinguishable.
 *
 * Trimming to three segments can collapse genuinely different OSM entries to
 * the same string — Grand Central returns several, all rendering as "Grand
 * Central Terminal, 89, East 42nd Street". Offering the walker two identical
 * options is worse than offering one long one, because there's no way to tell
 * which is which, so colliding labels get lengthened until they differ.
 */
function labelUniquely(rows: NominatimRow[]): string[] {
  const labels = rows.map((r) => shorten(r));

  for (let depth = 4; depth <= 7; depth++) {
    const counts = new Map<string, number>();
    for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    if ([...counts.values()].every((n) => n === 1)) break;

    for (let i = 0; i < labels.length; i++) {
      if ((counts.get(labels[i]) ?? 0) > 1) labels[i] = shorten(rows[i], depth);
    }
  }

  // Still identical after seven segments means they really are the same place
  // listed twice; drop the duplicates rather than show them.
  const seen = new Set<string>();
  return labels.map((l) => (seen.has(l) ? "" : (seen.add(l), l)));
}

export function normaliseQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function geocode(input: string): Promise<GeocodeResult> {
  const key = normaliseQuery(input);
  if (!key) return { status: "not-found" };

  const hit = cache.get(key);
  if (hit) return hit;

  const { south, west, north, east } = PILOT.bbox;

  // `bounded=1` makes viewbox a hard filter rather than a preference — without
  // it, "Broadway" cheerfully returns Nashville.
  const inside = await query({
    q: input,
    viewbox: `${west},${north},${east},${south}`,
    bounded: "1",
  });

  let result: GeocodeResult;

  if (inside.length > 0) {
    // Drop exact repeats *before* labelling. Doing it the other way round makes
    // `labelUniquely` lengthen a label to tell two identical places apart, and
    // you end up with one survivor wearing a seven-segment name for no reason.
    const seen = new Set<string>();
    const rows = inside.filter((r) => {
      const key = r.display_name ?? `${r.lon},${r.lat}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const labels = labelUniquely(rows);
    result = {
      status: "ok",
      places: rows
        .map((r, i) => ({ label: labels[i], lon: Number(r.lon), lat: Number(r.lat) }))
        .filter((p) => p.label !== ""),
    };
  } else {
    // Nothing in the pilot area. One unbounded lookup tells us *which* failure
    // this is, and it only costs a request when we've already failed.
    const anywhere = await query({ q: input, limit: "1" });
    result =
      anywhere.length > 0
        ? { status: "out-of-area", nearest: shorten(anywhere[0]) }
        : { status: "not-found" };
  }

  cache.set(key, result);
  return result;
}
