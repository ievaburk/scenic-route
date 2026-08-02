/**
 * Pull everything the scenic score is computed *from*: OSM scenic features via
 * Overpass, plus the two NYC Open Data layers that cover OSM's blind spot.
 *
 *   npm run fetch:features            # fetch what's missing
 *   npm run fetch:features -- --force # re-fetch everything
 *
 * Three sources, each cached to data/raw/ and independently resumable:
 *
 *   1. Overpass scenic features, one query per tile. Deliberately one broad
 *      query rather than one per axis — 25 requests instead of 250 against a
 *      rate-limited free service, and re-categorising later costs a re-score
 *      rather than a re-fetch. See lib/features.ts.
 *   2. NYC historic districts (DCP ArcGIS). LPC-designated districts plus the
 *      State/National Register ones and scenic landmarks.
 *   3. NYC 2015 Street Tree Census (Socrata). ~104k live trees in the pilot
 *      bbox, which is a far better canopy signal than OSM's `natural=tree`.
 *
 * On (2): NYC Open Data's own "Historic Districts (Map)" dataset (xbvj-gfnw)
 * is the obvious source and it is *dead* — both its GeoJSON and CSV exports
 * return an empty body with a 200. DCP's ArcGIS layer is the live copy.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fetchTilesCached, sleep } from "../lib/overpass";
import { FEATURE_SELECTORS } from "../lib/features";
import { PILOT, tiles, type BBox } from "../lib/pilot";

const RAW_DIR = path.join(process.cwd(), "data", "raw");

const HISTORIC_FILE = path.join(RAW_DIR, "nyc_historic_districts.json");
const TREES_FILE = path.join(RAW_DIR, "nyc_street_trees.json");

// ---------------------------------------------------------------------------
// 1. OSM scenic features
// ---------------------------------------------------------------------------

/**
 * `out geom` inlines each way's and relation member's coordinates. The road
 * network needs the `>; out skel qt;` dance instead because it wants node IDs
 * to build topology from; scenic features only need shapes, so this is both
 * simpler and smaller.
 */
function featureQuery(b: BBox): string {
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  const selectors = FEATURE_SELECTORS.map((s) => `  ${s}(${bbox});`).join("\n");
  return `[out:json][timeout:180];
(
${selectors}
);
out geom;`;
}

function featureTileName(b: BBox): string {
  return `feat_${b.south.toFixed(3)}_${b.west.toFixed(3)}.json`;
}

// ---------------------------------------------------------------------------
// 2. NYC historic districts (DCP ArcGIS)
// ---------------------------------------------------------------------------

const ARCGIS_LAYER =
  "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/ArcGIS/rest/services" +
  "/v_GFT_Historic_Districts/FeatureServer/0/query";

/** ArcGIS caps a page at maxRecordCount (2000 here); page until it says stop. */
const ARCGIS_PAGE = 1000;

type GeoJSONFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: unknown;
};

async function fetchHistoricDistricts(force: boolean): Promise<number | null> {
  if (!force && existsSync(HISTORIC_FILE)) {
    console.log("nyc_historic_districts.json cached");
    return null;
  }

  const { south, west, north, east } = PILOT.bbox;
  const features: GeoJSONFeature[] = [];

  for (let offset = 0; ; offset += ARCGIS_PAGE) {
    const params = new URLSearchParams({
      where: "1=1",
      outFields: "variable_id,variable_type",
      outSR: "4326",
      f: "geojson",
      geometry: `${west},${south},${east},${north}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      resultOffset: String(offset),
      resultRecordCount: String(ARCGIS_PAGE),
    });

    const res = await fetch(`${ARCGIS_LAYER}?${params}`);
    if (!res.ok) throw new Error(`ArcGIS ${res.status} ${res.statusText}`);

    const page = (await res.json()) as {
      features?: GeoJSONFeature[];
      error?: { message?: string };
    };
    if (page.error) throw new Error(`ArcGIS: ${page.error.message}`);

    const batch = page.features ?? [];
    features.push(...batch);
    console.log(`  historic districts +${batch.length} (${features.length})`);
    if (batch.length < ARCGIS_PAGE) break;
  }

  await writeFile(
    HISTORIC_FILE,
    JSON.stringify({ type: "FeatureCollection", features }),
  );
  return features.length;
}

// ---------------------------------------------------------------------------
// 3. NYC 2015 Street Tree Census (Socrata)
// ---------------------------------------------------------------------------

const TREES_URL = "https://data.cityofnewyork.us/resource/uvpi-gqnh.json";
/** Socrata's hard ceiling per page is 50k; stay under it. */
const TREES_PAGE = 25_000;

type TreeRow = { latitude: string; longitude: string; spc_common?: string };

async function fetchStreetTrees(force: boolean): Promise<number | null> {
  if (!force && existsSync(TREES_FILE)) {
    console.log("nyc_street_trees.json cached");
    return null;
  }

  const { south, west, north, east } = PILOT.bbox;
  // Dead and stumped trees are in the census too and contribute no canopy.
  const where =
    `latitude between ${south} and ${north} ` +
    `AND longitude between ${west} and ${east} ` +
    `AND status='Alive'`;

  // Only the three columns scoring uses. The full row is ~45 columns wide and
  // 104k of them is a pointlessly large file on disk.
  const trees: [number, number][] = [];

  for (let offset = 0; ; offset += TREES_PAGE) {
    const params = new URLSearchParams({
      $select: "latitude,longitude",
      $where: where,
      $order: "tree_id",
      $limit: String(TREES_PAGE),
      $offset: String(offset),
    });

    const res = await fetch(`${TREES_URL}?${params}`);
    if (!res.ok) throw new Error(`Socrata ${res.status} ${res.statusText}`);

    const page = (await res.json()) as TreeRow[];
    for (const t of page) {
      const lon = Number(t.longitude);
      const lat = Number(t.latitude);
      if (Number.isFinite(lon) && Number.isFinite(lat)) trees.push([lon, lat]);
    }
    console.log(`  street trees +${page.length} (${trees.length})`);
    if (page.length < TREES_PAGE) break;

    await sleep(500);
  }

  // Stored as bare [lon, lat] pairs: 104k GeoJSON point features would be ~15 MB
  // of repeated boilerplate for two numbers each.
  await writeFile(TREES_FILE, JSON.stringify({ source: TREES_URL, trees }));
  return trees.length;
}

// ---------------------------------------------------------------------------

async function main() {
  const force = process.argv.includes("--force");
  await mkdir(RAW_DIR, { recursive: true });

  const all = tiles();
  console.log(`OSM scenic features · ${all.length} tiles\n`);

  const osm = await fetchTilesCached({
    dir: RAW_DIR,
    tiles: all,
    fileFor: featureTileName,
    queryFor: featureQuery,
    force,
  });
  console.log(
    `${osm.fetched} fetched, ${osm.cached} cached · ${(osm.bytes / 1e6).toFixed(1)} MB of features\n`,
  );

  console.log("NYC historic districts (DCP ArcGIS)");
  const districts = await fetchHistoricDistricts(force);
  if (districts !== null) console.log(`  → ${districts} polygons\n`);

  console.log("NYC 2015 Street Tree Census (Socrata)");
  const trees = await fetchStreetTrees(force);
  if (trees !== null) console.log(`  → ${trees} live trees\n`);

  console.log("Done. Next: npm run score:graph");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
