/**
 * Pull the walkable network for the pilot area from Overpass, one tile at a
 * time, caching each raw response to disk.
 *
 * Caching is the point: Overpass is a shared free service with real rate
 * limits, and the graph build gets re-run constantly while scoring is being
 * tuned. Fetch once, rebuild as often as you like.
 *
 *   npm run fetch:osm            # fetch missing tiles
 *   npm run fetch:osm -- --force # re-fetch everything
 *
 * Scenic features are a separate extraction — see `fetch-features.ts`.
 */
import path from "node:path";
import { fetchTilesCached } from "../lib/overpass";
import { PILOT, WALKABLE_HIGHWAY_VALUES, tiles, type BBox } from "../lib/pilot";

const RAW_DIR = path.join(process.cwd(), "data", "raw");

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

async function main() {
  const all = tiles();
  console.log(
    `Pilot area ${PILOT.bbox.south},${PILOT.bbox.west} → ${PILOT.bbox.north},${PILOT.bbox.east}`,
  );
  console.log(`${all.length} tiles\n`);

  const { fetched, cached, bytes } = await fetchTilesCached({
    dir: RAW_DIR,
    tiles: all,
    fileFor: tileName,
    queryFor: query,
    force: process.argv.includes("--force"),
  });

  console.log(
    `\n${fetched} fetched, ${cached} cached · ${(bytes / 1e6).toFixed(1)} MB of walkable network`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
