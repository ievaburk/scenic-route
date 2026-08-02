<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Scenic Route

A walking navigation app that optimises for *interesting* rather than *fast*.
Read [PLAN.md](PLAN.md) first — it holds the product definition, the scoring
design, and the build order. This file is only the conventions.

## Locked decisions

Do not relitigate these; they were settled deliberately.

- **Walking only.** No driving, no turn-by-turn voice in v1. A map with a
  highlighted route is the whole UI.
- **Loop mode is the wedge**, not A-to-B. Google Maps cannot express "give me a
  nice 40 minutes from here", which is where the unserved demand is.
- **Own the router.** Bidirectional A* in TypeScript, in-process. Hosted
  routing APIs can't take custom per-edge weights, which is the entire product.
  No Docker on this machine, so Valhalla/OSRM are out anyway.
- **Explicit preference tags first**, learned weights layered on later.
- **Free-text interests are MVP**, not a later nicety (see PLAN.md §6).

## Data pipeline

```bash
npm run fetch:osm     # Overpass → data/raw/*.json  (slow, cached, resumable)
npm run build:graph   # data/raw → data/graph.json  (fast, re-run freely)
```

- `data/` is gitignored and fully rebuildable. Never commit it.
- **Every edge keeps its full raw OSM tag set** (deduplicated per way). This is
  load-bearing: free-text interests need to ask "is this edge a bridge / cobbled
  / art deco", and you cannot answer that against six precomputed numbers.
- Overpass **406s on undici's default user-agent** — requests must send a real
  `User-Agent`. It also rate-limits hard; backoff is in seconds, not ms.
- `fetch-osm.ts` caches per tile so an interrupted run resumes. Keep it that way.

## Map surface (MapLibre)

Every one of these cost real debugging time and none is guessable from the code.

- **maplibre-gl v6 has no default export** — `import { Map, NavigationControl } from
  "maplibre-gl"`, never `import maplibregl from "maplibre-gl"`.
- **The worker does not start under Turbopack.** MapLibre derives its worker URL from
  `import.meta.url`, which resolves into `/_next/static/chunks/`, so the script 404s —
  and it fails *silently*: style and sprite load on the main thread, so you get map
  controls and attribution over a blank grey rectangle while every tile request waits
  forever on a worker that never answered. `scripts/copy-map-worker.ts` (wired to
  `predev`/`prebuild`) copies the worker into `public/maplibre/`, and the client calls
  `setWorkerUrl("/maplibre/maplibre-gl-worker.mjs")` before constructing the map.
- **Never size a map container with `absolute inset-0`.** maplibre's stylesheet sets
  `.maplibregl-map { position: relative }` and loads after Tailwind, so it wins and the
  container collapses to zero height. Use `h-full`.
- **Add sources and layers on `styledata`, not `load`.** `load` waits for every source
  the basemap style declares *and* a rendered frame, so one slow source — or a
  backgrounded tab, which pauses animation frames — leaves your layers unadded forever.
- **Always wire `map.on("error")`.** Without it, all of the above look identical: an
  empty grey map and a clean console.
- Lines draw ~2px at street zoom, so a transparent `line-width: 14` hit layer over the
  top is what makes edges clickable.

## Pilot area

Manhattan below 125th St + brownstone Brooklyn — see `lib/pilot.ts`. Small
enough to hold in one process and small enough to check scoring against real
knowledge of the streets. Current graph: ~170k edges, ~116k nodes, ~4,980 km.

## Scoring conventions

- Six core axes (green, water, architecture/historic, art/landmarks, quiet,
  hills/views) are **dense** — precomputed for every edge.
- Custom free-text interests are **sparse** — per-interest edge→score maps,
  computed once per city and cached globally.
- **Normalise every axis by percentile across the city, not absolute value.**
  Absolute normalisation means a city with no river can never produce a water
  route. The question is "watery relative to what this city offers".
- Route cost is `time(e) · (1 − α · scenic(e))`, α ∈ [0, 0.9). Keeps costs
  non-negative so plain A* stays valid. The detour budget is a binary search
  on α. See PLAN.md §8.

## Environment

- Node 24 via nvm; no Docker, no Homebrew.
- Map tiles: OpenFreeMap (no API key). MapLibre GL, not Mapbox.
- Supabase is not wired up yet and isn't needed until the product shell phase.
