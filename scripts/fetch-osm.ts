/**
 * Pull the walkable network for the pilot area from Overpass, one tile at a
 * time, caching each raw response to disk.
 *
 * Caching is the point: Overpass is a shared free service with real rate
 * limits, and the graph build below gets re-run constantly while scoring is
 * being tuned. Fetch once, rebuild as often as you like.
 *
 *   npm run fetch:osm            # fetch missing tiles
 *   npm run fetch:osm -- --force # re-fetch everything
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { PILOT, WALKABLE_HIGHWAY_VALUES, tiles, type BBox } from "../lib/pilot";

const RAW_DIR = path.join(process.cwd(), "data", "raw");

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/**
 * Overpass 406s on undici's default user-agent — it wants a request that
 * identifies itself. This is also just the polite thing to do on a free
 * shared endpoint.
 */
const USER_AGENT = "scenic-route/0.1 (walking-route prototype)";

/**
 * `out body` gives us way tags + node refs; `>; out skel qt;` then pulls the
 * bare coordinates of every referenced node, including ones outside the tile.
 * That means ways straddling a tile edge come back whole rather than severed.
 */
function query(b: BBox): string {
  const filter = WALKABLE_HIGHWAY_VALUES.join("|");
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  return `[out:json][timeout:180];
(
  way["highway"~"^(${filter})$"](${bbox});
);
out body;
>;
out skel qt;`;
}

function tileName(b: BBox): string {
  return `walk_${b.south.toFixed(3)}_${b.west.toFixed(3)}.json`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Endpoints that turned out to be unreachable from here, so we stop trying. */
const unreachable = new Set<string>();

/**
 * Overpass hands out query slots and 429s when you're out of them, so backoff
 * has to be generous — seconds, not milliseconds.
 */
const BACKOFF_MS = [15_000, 30_000, 60_000, 90_000, 120_000, 180_000];

async function fetchTile(b: BBox, attempt = 0): Promise<string> {
  const endpoint = ENDPOINTS.find((e) => !unreachable.has(e));
  if (!endpoint) throw new Error("No reachable Overpass endpoint");

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ data: query(b) }),
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
        return fetchTile(b, attempt + 1);
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
      return fetchTile(b, attempt);
    }
    // An HTTP status we've decided not to retry is final — don't let the
    // generic network retry below swallow it into a loop.
    if (err instanceof Error && err.message.startsWith("Overpass ")) throw err;

    if (attempt < BACKOFF_MS.length) {
      const wait = BACKOFF_MS[attempt];
      console.log(`  connection dropped, retrying in ${wait / 1000}s`);
      await sleep(wait);
      return fetchTile(b, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  const force = process.argv.includes("--force");
  await mkdir(RAW_DIR, { recursive: true });

  const all = tiles();
  console.log(
    `Pilot area ${PILOT.bbox.south},${PILOT.bbox.west} → ${PILOT.bbox.north},${PILOT.bbox.east}`,
  );
  console.log(`${all.length} tiles\n`);

  let fetched = 0;
  let cached = 0;
  let bytes = 0;

  for (const [i, b] of all.entries()) {
    const file = path.join(RAW_DIR, tileName(b));
    const label = `[${i + 1}/${all.length}] ${tileName(b)}`;

    if (!force && existsSync(file)) {
      bytes += (await readFile(file)).byteLength;
      cached++;
      console.log(`${label} cached`);
      continue;
    }

    const body = await fetchTile(b);
    await writeFile(file, body);
    bytes += Buffer.byteLength(body);
    fetched++;

    const ways = (body.match(/"type"\s*:\s*"way"/g) ?? []).length;
    console.log(`${label} ${ways} ways, ${(body.length / 1e6).toFixed(1)} MB`);

    // Be a good citizen on a free shared endpoint — and stay under the slot
    // limit so we don't spend the run in backoff.
    await sleep(5000);
  }

  console.log(
    `\n${fetched} fetched, ${cached} cached · ${(bytes / 1e6).toFixed(1)} MB in data/raw`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
