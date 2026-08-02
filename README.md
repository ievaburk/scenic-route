# Scenic Route

Walking navigation that optimises for *most interesting* instead of *fastest* —
through parks rather than along arterials, past water, quiet streets, notable
architecture, statues and viewpoints, and past whatever else you happen to be
obsessed with.

See [PLAN.md](PLAN.md) for the product definition and full build plan, and
[AGENTS.md](AGENTS.md) for working conventions.

## Setup

```bash
npm install
npm run fetch:osm     # ~10-25 min, rate-limited by Overpass, resumable
npm run build:graph   # ~1 min
npm run dev
```

`data/` is gitignored and entirely rebuildable from those two scripts.

## Where this is up to

**Phase 0 (data spike) — done.**

Working:

- Next 16 / React 19 / Tailwind 4 scaffold
- `scripts/fetch-osm.ts` — Overpass extraction over the pilot bbox, cached per
  tile so an interrupted run resumes
- `scripts/build-graph.ts` — ways split at junctions into a routable graph,
  largest connected component only, full raw OSM tags retained per edge
- `/debug/graph` — the whole network on MapLibre + OpenFreeMap, coloured by road
  class, toggleable per class, click any edge for its raw OSM tags

Current graph over Manhattan below 125th + brownstone Brooklyn:

| | |
|---|---|
| edges | 170,358 |
| nodes | 115,938 |
| walkable network | 4,984 km |
| artifact | 30.9 MB |
| largest component | 92.4% of junctions |

The map was checked against the landmarks in PLAN.md §13 — the Brooklyn Heights
Promenade, the Hudson River Greenway and Riverside Park all come through with
their path networks intact and connected.

**Next up: Phase 1 (scoring)**, which is the phase that decides whether the whole
idea works: six-axis per-edge scoring, plus NYC LPC historic districts and the
street tree census — those two datasets cover ordinary beautiful streets, which
is OSM's worst blind spot.

## Data

OpenStreetMap via Overpass, ODbL. Attribution is required on any map surface.
