<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Scenic Route

A walking navigation app that optimises for *interesting* rather than *fast*.
Read `PLAN.md` first — it holds the product definition, the scoring design, and
the build order. This file is only the conventions.

`PLAN.md` is gitignored and stays local: it's the product strategy, not
documentation. It is still the source of truth for anyone working in this repo,
and the `PLAN.md §N` citations throughout the code refer to it.

## Locked decisions

Do not relitigate these; they were settled deliberately.

- **Walking only.** No driving, no turn-by-turn voice in v1. A map with a
  highlighted route is the whole UI.
- **Loop mode ships before A-to-B.** "A nice 40 minutes from here, back to
  here" is the first user-facing surface; A-to-B follows. Build order is set in
  PLAN.md §12 — don't reorder it.
- **Own the router.** Bidirectional A* in TypeScript, in-process. Hosted routing
  APIs can't accept custom per-edge weights, so they can't express the scoring
  this app is built around. No Docker on this machine either, so Valhalla and
  OSRM are out regardless.
- **Explicit preference tags first**, learned weights layered on later.
- **Free-text interests are MVP**, not a later nicety (see PLAN.md §6).

## Data pipeline

```bash
npm run fetch:osm       # Overpass → data/raw/walk_*.json  (slow, cached, resumable)
npm run build:graph     # data/raw → data/graph.json       (fast, re-run freely)
npm run fetch:features  # Overpass + NYC Open Data → data/raw/  (slow, cached)
npm run score:graph     # graph + features → data/scores.json   (~5s, re-run freely)
```

- `data/` is gitignored and fully rebuildable. Never commit it.
- **Every edge keeps its full raw OSM tag set** (deduplicated per way). This is
  load-bearing: free-text interests need to ask "is this edge a bridge / cobbled
  / art deco", and you cannot answer that against six precomputed numbers.
- Overpass **406s on undici's default user-agent** — requests must send a real
  `User-Agent`. It also rate-limits hard; backoff is in seconds, not ms. The
  feature query is broad and **504s far more than the network query does** —
  the backoff ladder has to reach 90s+ or a run dies halfway.
- Both fetch scripts cache per tile so an interrupted run resumes. Keep it that
  way. Shared client is `lib/overpass.ts`.
- The network query needs `out body; >; out skel qt;` because it wants node IDs
  to build topology from. **Features use `out geom`** instead — they only need
  shapes, and it skips the whole node-resolution pass.
- **One broad feature query per tile, not one per axis.** Categorisation happens
  at score time in `lib/features.ts`, so retuning what "architecture" means
  costs a 5-second re-score instead of another 20 minutes against Overpass.

### Two data traps, both of which produced plausible-looking wrong maps

- **NYC Open Data's own Historic Districts dataset (`xbvj-gfnw`) is dead.** Its
  GeoJSON *and* CSV exports both return HTTP 200 with an empty body — no error,
  just no features. The live copy is DCP's ArcGIS layer
  (`v_GFT_Historic_Districts`), which is also strictly better: it carries LPC
  districts, State/National Register districts and scenic landmarks, tagged by
  `variable_type`.
- **OSM multipolygon members are usually *open* chains.** A large park's
  boundary is routinely split across several ways, so no single member is a
  closed ring. Treat members individually and the park has no interior at all —
  Prospect Park and Governors Island both come back that way in the pilot
  extract, and "inside a park" is exactly where the paths worth routing down
  are. `assembleRings` in `score-graph.ts` stitches them; deleting it silently
  drops ~9% of green coverage.

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

## Router

- **Bidirectional A* needs balanced potentials**, `p_f = (h_f − h_b)/2` and
  `p_b = −p_f`, not each side using its own heuristic. Because the two sum to
  zero, the stopping rule `topF + topB ≥ μ` is *exact*. With raw per-side
  heuristics the potentials don't cancel, the rule stops bounding what's
  unexplored, and the search returns paths that are wrong but entirely
  plausible-looking on a map. `npm run check:router` compares against plain
  Dijkstra over the same cost function — run it after touching `lib/router.ts`,
  because nothing else will catch this.
- The price of balanced potentials is a weaker heuristic: A* is only ~1.2×
  faster than Dijkstra on long cross-city pairs. Real walks (1–3 km) are
  0.3–0.4 ms, so it doesn't matter. Don't "fix" it by reverting to raw
  heuristics.
- **Cache the potential per node.** It's read on every edge relaxation but is
  constant per node; recomputing made A* no faster than Dijkstra.
- **Never penalise the fastest route.** It's the baseline every "+N minutes"
  figure is measured against (PLAN.md §8), so the diversity pass must skip it —
  otherwise the headline number is a lie.
- **Two different aggregators, deliberately.** Routing uses `compositeScore`
  (linear, PLAN.md §8) because at route time the weights are the user's own and
  already zero the axes they don't care about. The debug map uses
  `overallScore` (quadratic) to answer "interesting for any reason at all".
  Don't unify them.
- **α saturates and the slack budget rarely binds** in Manhattan's grid: the
  parallel street one block over is much nicer at almost no time cost, so the
  search takes it and stops well short of the offered detour. Expect the slack
  slider to feel unresponsive here; that's the data, not a bug.

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
  route. The question is "watery relative to what this city offers". Two details
  in `percentileNormalise` are not optional:
  - **Zeros stay zero.** Rank the whole population and an edge with no water
    within 200 m gets a middling water percentile purely because most other
    edges have none either.
  - **Ties share a rank.** `quiet` takes about a dozen distinct raw values, so
    ranking by sorted position smears every residential street in the city
    across a wide range in arbitrary order.
- `quiet` is the one axis with no features behind it — nothing in OSM tags it,
  so it's derived from the edge's own road class, lanes and maxspeed.
- Scores are **index-aligned with `graph.edges` and nothing in the file format
  enforces it.** Rebuild the graph without re-scoring and every lookup shifts to
  a different street, producing a completely plausible wrong map.
  `scoresFor()` refuses a mismatch by comparing `graph.meta.builtAt`; don't
  route around it.
- Route cost is `time(e) · (1 − α · scenic(e))`, α ∈ [0, 0.9). Keeps costs
  non-negative so plain A* stays valid. The detour budget is a binary search
  on α. See PLAN.md §8.

## Environment

- Node 24 via nvm; no Docker, no Homebrew.
- Map tiles: OpenFreeMap (no API key). MapLibre GL, not Mapbox.
- Supabase is not wired up yet and isn't needed until the product shell phase.
