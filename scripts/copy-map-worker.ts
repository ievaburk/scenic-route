/**
 * Put MapLibre's worker script somewhere the browser can actually fetch it.
 *
 * MapLibre resolves its worker URL from `import.meta.url` at runtime. Once
 * Turbopack bundles the library into a chunk, that resolves to
 * `/_next/static/chunks/maplibre-gl-worker.mjs`, which doesn't exist — and the
 * failure is silent: the style and sprite load on the main thread, so you get
 * map controls and attribution over a blank grey rectangle while every tile
 * request waits forever on a worker that never started.
 *
 * Copying the worker into `public/` and pointing `setWorkerUrl` at it is the
 * supported fix. The worker imports `./maplibre-gl-shared.mjs` relative to
 * itself, so both files have to land in the same directory.
 *
 * Copied at build time rather than committed so it cannot drift from the
 * installed version of maplibre-gl. Runs from `predev` and `prebuild`.
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SRC_DIR = path.join(process.cwd(), "node_modules", "maplibre-gl", "dist");
const DEST_DIR = path.join(process.cwd(), "public", "maplibre");

/** The worker, plus the shared chunk it imports relatively. */
const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

async function main() {
  await mkdir(DEST_DIR, { recursive: true });
  for (const file of FILES) {
    await copyFile(path.join(SRC_DIR, file), path.join(DEST_DIR, file));
  }
  console.log(`maplibre worker → public/maplibre/ (${FILES.join(", ")})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
