/**
 * Shared Overpass client: endpoint failover, backoff, and per-tile disk cache.
 *
 * Factored out of `scripts/fetch-osm.ts` when `scripts/fetch-features.ts`
 * arrived and needed exactly the same rate-limit manners. The two scripts
 * differ only in what they ask for and where they cache it.
 *
 * Two things here are learned rather than obvious:
 *   - Overpass 406s on undici's default user-agent. It wants a request that
 *     identifies itself.
 *   - Its backoff is measured in seconds, not milliseconds. It hands out query
 *     slots and 429s when you're out of them.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { BBox } from "./pilot";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const USER_AGENT = "scenic-route/0.1 (walking-route prototype)";

/** Generous on purpose — see the note about query slots above. */
const BACKOFF_MS = [15_000, 30_000, 60_000, 90_000, 120_000, 180_000];

/** Polite gap between successful queries, so we don't spend the run in backoff. */
export const POLITE_GAP_MS = 5000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Endpoints that turned out to be unreachable from here, so we stop trying. */
const unreachable = new Set<string>();

export async function fetchOverpass(query: string, attempt = 0): Promise<string> {
  const endpoint = ENDPOINTS.find((e) => !unreachable.has(e));
  if (!endpoint) throw new Error("No reachable Overpass endpoint");

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ data: query }),
    });

    if (!res.ok) {
      // 429 = out of slots, 504 = query timed out under load. Both clear on
      // their own if you simply wait.
      if (
        (res.status === 429 || res.status === 504) &&
        attempt < BACKOFF_MS.length
      ) {
        const wait = BACKOFF_MS[attempt];
        console.log(`  ${res.status} from Overpass, waiting ${wait / 1000}s`);
        await sleep(wait);
        return fetchOverpass(query, attempt + 1);
      }
      throw new Error(`Overpass ${res.status} ${res.statusText}`);
    }

    // Reading the body has to be inside the try: these responses are megabytes
    // and the connection can drop mid-stream, which throws here rather than at
    // the fetch call.
    return await res.text();
  } catch (err) {
    // A mirror that doesn't resolve is not a transient failure — retrying it
    // just burns the attempt budget. Drop it and use whatever else is left.
    const cause = (err as { cause?: { code?: string } })?.cause;
    if (cause?.code === "ENOTFOUND" || cause?.code === "ECONNREFUSED") {
      console.log(`  ${new URL(endpoint).host} unreachable, dropping it`);
      unreachable.add(endpoint);
      return fetchOverpass(query, attempt);
    }
    // An HTTP status we've decided not to retry is final — don't let the
    // generic network retry below swallow it into a loop.
    if (err instanceof Error && err.message.startsWith("Overpass ")) throw err;

    if (attempt < BACKOFF_MS.length) {
      const wait = BACKOFF_MS[attempt];
      console.log(`  connection dropped, retrying in ${wait / 1000}s`);
      await sleep(wait);
      return fetchOverpass(query, attempt + 1);
    }
    throw err;
  }
}

/**
 * Fetch one Overpass query per tile, skipping tiles already on disk.
 *
 * The cache is the whole point: Overpass is a free shared service, and the
 * downstream builds get re-run constantly while scoring is tuned. An
 * interrupted run resumes from wherever it stopped.
 */
export async function fetchTilesCached(opts: {
  dir: string;
  tiles: BBox[];
  fileFor: (b: BBox) => string;
  queryFor: (b: BBox) => string;
  force: boolean;
}): Promise<{ fetched: number; cached: number; bytes: number }> {
  await mkdir(opts.dir, { recursive: true });

  let fetched = 0;
  let cached = 0;
  let bytes = 0;

  for (const [i, b] of opts.tiles.entries()) {
    const name = opts.fileFor(b);
    const file = path.join(opts.dir, name);
    const label = `[${i + 1}/${opts.tiles.length}] ${name}`;

    if (!opts.force && existsSync(file)) {
      bytes += (await readFile(file)).byteLength;
      cached++;
      console.log(`${label} cached`);
      continue;
    }

    const body = await fetchOverpass(opts.queryFor(b));
    await writeFile(file, body);
    bytes += Buffer.byteLength(body);
    fetched++;

    const elements = (body.match(/"type"\s*:\s*"(node|way|relation)"/g) ?? [])
      .length;
    console.log(
      `${label} ${elements} elements, ${(body.length / 1e6).toFixed(1)} MB`,
    );

    await sleep(POLITE_GAP_MS);
  }

  return { fetched, cached, bytes };
}
