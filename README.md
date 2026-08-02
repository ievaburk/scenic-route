# Scenic Route

Walking navigation that optimises for *most interesting* instead of *fastest* —
through parks rather than along arterials, past water, quiet streets, notable
architecture, statues and viewpoints, and past whatever else you happen to be
obsessed with.

See [AGENTS.md](AGENTS.md) for working conventions.

> Code comments and AGENTS.md cite `PLAN.md` by section — §5 for data sources,
> §8 for the detour-budget maths, §13 for verification. That document is the
> product strategy rather than documentation and is deliberately not published,
> so those citations won't resolve here. Everything needed to build, run and
> understand the code is in this repo; the references are there to explain *why*
> a decision was made, and the reasoning is generally restated inline where it
> matters.

## Setup

```bash
npm install
npm run fetch:osm       # ~10-25 min, rate-limited by Overpass, resumable
npm run build:graph     # ~1 min
npm run fetch:features  # ~15-30 min, same rate limits, resumable
npm run score:graph     # ~8 s — re-run freely while tuning
npm run dev             # then open /debug/graph
```

`data/` is gitignored and entirely rebuildable from those four scripts. Only
the two fetches are slow; the build and score steps are meant to be re-run
constantly while the scoring is being tuned.

```bash
npm run check:landmarks   # Phase 1 regression net — run on every scoring change
npm run check:router      # proves the A* is optimal, against plain Dijkstra
npm run check:routes      # Phase 2 fixtures — 20 O/D pairs, budget/α/diversity
```

## Where this is up to

**Phase 0 (data spike) — done. Phase 1 (scoring) — done.**

Working:

- Next 16 / React 19 / Tailwind 4 scaffold
- `scripts/fetch-osm.ts` — Overpass extraction over the pilot bbox, cached per
  tile so an interrupted run resumes
- `scripts/build-graph.ts` — ways split at junctions into a routable graph,
  largest connected component only, full raw OSM tags retained per edge
- `scripts/fetch-features.ts` — scenic features from Overpass, plus NYC LPC
  historic districts and the 2015 Street Tree Census
- `scripts/score-graph.ts` — six-axis per-edge scoring: R-tree proximity with
  distance decay, derived quiet, percentile normalisation across the city
- `scripts/check-landmarks.ts` — the ship-blocking regression net (PLAN.md §13)
- `/debug/graph` — every edge on MapLibre + OpenFreeMap, coloured by scenic
  score or by any single axis, with a percentile threshold slider; click any
  edge for its score breakdown and raw OSM tags

Graph over Manhattan below 125th + brownstone Brooklyn:

| | |
|---|---|
| edges | 170,358 |
| nodes | 115,938 |
| walkable network | 4,984 km |
| graph artifact | 30.9 MB |
| largest component | 92.4% of junctions |

Scoring inputs and coverage:

| | |
|---|---|
| OSM scenic features | 14,119 |
| street trees (2015 census) | 104,007 |
| historic district polygons | 986 |
| score artifact | 4.1 MB, ~8 s to rebuild |

| axis | edges scored |
|---|---|
| green | 95.8% |
| quiet | 100% |
| architecture / historic | 55.1% |
| water | 30.1% |
| hills & views | 20.4% |
| art & landmarks | 11.0% |

**The Phase 1→2 checkpoint passes: 8/8 landmarks in band.** Central Park 0.74,
Prospect Park 0.66, Hudson River Greenway 0.59, Riverside Park 0.58, Brooklyn
Heights Promenade 0.57 — against 8th Ave / Midtown 0.30 and Hell's Kitchen 0.21.
The three named in PLAN.md §13 all glow and the named negative doesn't.

Two findings from this phase worth knowing before touching the scoring:

- The **street tree census and LPC districts do the heavy lifting** for ordinary
  streets, exactly as PLAN.md §5 predicted. Park Slope's architecture score is
  0.59 inside the historic district and 0.07 two blocks west of it.
- The **"overall" score is a quadratic mean, not a flat average**, because the
  six axes are alternative reasons to like a street rather than components of
  one quantity. Averaging flat rated the Hudson River Greenway — 0.90 green,
  0.94 water — as mediocre for lacking monuments. Routing still uses the linear
  form from PLAN.md §8, where the weights are the user's own. See
  `lib/scoring.ts`.

**Phase 2 (engine) — done.**

- `lib/router.ts` — bidirectional A* over `time(e) · (1 − α · scenic(e))`, with
  balanced potentials so the bidirectional stopping rule is exact
- `lib/plan-route.ts` — α binary search against the detour budget, penalty-method
  alternates, overlap rejection
- `POST /api/route` — origin + destination → three scored routes as GeoJSON with
  per-axis exposure
- `/debug/route` — two clicks on the map, three lines, with axis toggles, a
  slack slider, and **shift-click to route via a place**

| | |
|---|---|
| optimality | 240/240 vs Dijkstra, zero cost gap |
| fixtures | 20/20 pairs pass; 19/20 gain scenic value from α |
| per plan | ~7 ms, ~11 A* searches |
| single route | 0.3–0.4 ms typical, 7 ms worst-case cross-city |

Turning on green+quiet for a Midtown walk lifts quiet exposure from 0.19 to
0.62 for 24 extra seconds — the "canal path, not the avenue" move from §2,
which is the cheapest real gain over a conventional router.

Three findings worth knowing before Phase 3:

- **A per-edge discount can't make the router visit a named place.** It prefers
  nicer streets among comparable options, but won't walk a kilometre out of the
  way — two different scoring aggregators were tried against "go past the Hudson
  piers" and moved it zero metres. Via-points are the mechanism that works:
  shift-click, and Brooklyn Bridge → Carroll Gardens picks up 1,347 m of
  Brooklyn Bridge Park for +15 min.


- **α saturates and the slack budget rarely binds.** In the grid, a much nicer
  parallel street costs almost nothing, so the search takes it and stops far
  short of the offered detour. The slider will feel unresponsive in Manhattan.
- **Bidirectional A* is only ~1.2× faster than Dijkstra** on long pairs, because
  balanced potentials halve the heuristic's strength. That's the price of exact
  termination and it's the right trade — real walks are sub-millisecond.

**Phase 3 (custom interests) — done**, except the LLM fallback.

Type a phrase, get a verified count, watch it change the walk. Every dictionary
entry is grounded in a measured count from the extract rather than imagination —
§6 is blunt that verifying against the real graph is what stops the feature
being a lie.

| | |
|---|---|
| dictionary entries | 18, each with a measured count |
| fixtures | 26/26 (23 phrases + 3 route effects) |
| bridges / cobblestones / statues | 1,046 / 950 / 719 matches |

Asking for bridges puts 2.0 km of bridge on a Dumbo → Lower East Side walk;
statues add 584 m to Chelsea → East Village.

**Coverage reports three different failures, deliberately.** "ok", "thin" (real
but too few to shape a walk), and "not extracted" (valid filter, but we never
queried that key — so we genuinely don't know). Art deco forced the distinction:
asking finds 4 matches, not because NYC has four art deco buildings but because
four buildings that matched *other* selectors carry the tag incidentally.
Reporting "4" would tell you your city has none. Phrases OSM will never know —
"smells like bakeries", "not too many tourists" — fail plainly rather than
becoming a dead weight.

**Interests amplify what's locally abundant; they can't summon a distant
cluster.** Same structural limit as the piers: asking for museums on a Midtown
walk changes nothing, because Museum Mile is a kilometre off-corridor and a
per-edge discount can't fund that. Via-points remain the mechanism for "go
there".

**Next up: Phase 4 (loop mode)** — the first real user-facing surface, with
anchor selection biased by the interests built above.

## Data

OpenStreetMap via Overpass, ODbL. Attribution is required on any map surface.
