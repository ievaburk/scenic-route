/**
 * Prepare walks you can actually go and do.
 *
 *   npm run walk:test
 *
 * PLAN.md §11's fourth hard part: there is no ground truth for "scenic", and
 * the only real evaluation is walking the routes. Every check in this repo so
 * far — 8/8 landmarks, 20/20 O/D pairs, 26/26 interests — grades the scoring
 * against my assumptions about New York rather than against New York. This
 * script is what closes that gap.
 *
 * Writes, per walk, into data/walk-test/:
 *   - `<id>.gpx`      the scenic route, for any phone map app
 *   - `<id>-fast.gpx` the fastest route, so the detour can be judged rather
 *                     than taken on trust
 *   - `index.html`    a self-contained sheet: stats, breakdown and
 *                     street-by-street directions, readable on a phone with no
 *                     network and printable if you'd rather carry paper
 *
 * Nothing here needs a server, an account or a signal — the point is to be
 * outside, away from the laptop that generated it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildRoutingGraph, makeScratch, type Route } from "../lib/router";
import { planRoutes } from "../lib/plan-route";
import { scenicArray, type ScoreArtifact } from "../lib/scoring";
import { AXIS_KEYS, DEFAULT_WEIGHTS, SCENIC_AXES, type ScenicAxis } from "../lib/features";
import { DICTIONARY } from "../lib/interests";
import { applyInterests, interestLayer, type InterestLayer } from "../lib/interest-layers";
import type { GraphArtifact } from "../lib/graph";

const DATA = path.join(process.cwd(), "data");
const OUT = path.join(DATA, "walk-test");
const FIXTURES = path.join(process.cwd(), "scripts", "fixtures", "walk-test.json");

/** Directions shorter than this get folded into the previous step. */
const MIN_STEP_M = 40;

type Walk = {
  id: string;
  name: string;
  tests: string;
  from: [number, number];
  to: [number, number];
  slackMin: number;
  interests?: string[];
  weights?: Partial<Record<ScenicAxis, number>>;
  ratings?: { date: string; rating: number; notes?: string }[];
};

function nearestNode(a: GraphArtifact, lon: number, lat: number): number {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < a.nodes.lon.length; i++) {
    const dx = (a.nodes.lon[i] - lon) * k;
    const dy = a.nodes.lat[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Route geometry as [lon, lat], edges stitched in travel order. */
function coordinates(a: GraphArtifact, route: Route): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < route.edges.length; i++) {
    const e = a.edges[route.edges[i]];
    const pts: [number, number][] = [];
    for (let j = 0; j < e.geom.length; j += 2) pts.push([e.geom[j], e.geom[j + 1]]);
    // Each edge stores its polyline in its own direction, not necessarily the
    // direction of travel — flip when we didn't enter from its stored start.
    if (e.a !== route.nodes[i]) pts.reverse();
    out.push(...(i === 0 ? pts : pts.slice(1)));
  }
  return out;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Bearing in degrees from a to b. */
function bearing(a: [number, number], b: [number, number]): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI;
}

/**
 * Directions derived from geometry, not from street names.
 *
 * The obvious implementation — group consecutive edges sharing a `name` — is
 * useless on this graph, and not checking that is how the first version of this
 * script emitted a 34-minute walk as a single instruction. Only 26% of edges
 * carry a name: the network is mostly `highway=footway` sidewalks and park
 * paths, which OSM leaves unnamed, so an entire waterfront route collapsed into
 * one step called "path".
 *
 * Turns therefore come from bearing changes between consecutive edges, with a
 * street name attached only when one exists. That degrades gracefully — a named
 * street reads "Left onto Hicks Street", an unnamed park path reads "Left" —
 * and it works on exactly the car-free routes this app exists to find.
 *
 * Not turn-by-turn navigation, which §12 rules out for v1. Just enough to
 * follow the line without staring at a screen.
 */
function directions(
  a: GraphArtifact,
  route: Route,
): { text: string; metres: number }[] {
  type Leg = { name: string | null; brg: number; metres: number; from: [number, number]; to: [number, number] };
  const legs: Leg[] = [];

  for (let i = 0; i < route.edges.length; i++) {
    const e = a.edges[route.edges[i]];
    const pts: [number, number][] = [];
    for (let j = 0; j < e.geom.length; j += 2) pts.push([e.geom[j], e.geom[j + 1]]);
    if (e.a !== route.nodes[i]) pts.reverse();

    const tags = a.tagSets[e.t] ?? {};
    legs.push({
      name: tags.name ?? (tags.highway === "steps" ? "steps" : null),
      brg: bearing(pts[0], pts[pts.length - 1]),
      metres: e.len,
      from: pts[0],
      to: pts[pts.length - 1],
    });
  }
  if (legs.length === 0) return [];

  // ---- 1. Segment into steps at turns and street changes -------------------
  type Group = { name: string | null; metres: number; from: [number, number]; to: [number, number] };
  const groups: Group[] = [];
  let heading = legs[0].brg;
  let currentName = legs[0].name;

  for (const leg of legs) {
    let delta = leg.brg - heading;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;

    const turned = Math.abs(delta) >= 35;
    const renamed = leg.name !== null && leg.name !== currentName;
    const last = groups[groups.length - 1];

    // Only break once the current step is long enough to be worth stating,
    // otherwise every crossing island becomes an instruction.
    if (!last || ((turned || renamed) && last.metres >= MIN_STEP_M)) {
      groups.push({ name: leg.name, metres: leg.metres, from: leg.from, to: leg.to });
    } else {
      last.metres += leg.metres;
      last.to = leg.to;
      if (leg.name && !last.name) last.name = leg.name;
    }

    heading = leg.brg;
    if (leg.name) currentName = leg.name;
  }

  // ---- 2. Describe each step from its OWN net bearing ----------------------
  // Turn word and compass must come from the same measurement or they
  // contradict each other: deriving the turn from the last edge's bearing while
  // labelling the step with its first edge produced "Head N" followed by
  // "Right (NW)", which is not a turn anyone can follow. Net start-to-end
  // bearing per step is what a walker actually experiences.
  return groups.map((gp, i) => {
    const brg = bearing(gp.from, gp.to);
    const facing = COMPASS[Math.round(((brg + 360) % 360) / 45) % 8];
    const onto = gp.name ? ` on ${gp.name}` : "";

    if (i === 0) return { text: `Head ${facing}${onto}`, metres: gp.metres };

    let delta = brg - bearing(groups[i - 1].from, groups[i - 1].to);
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;

    const dir =
      Math.abs(delta) < 35
        ? "Continue"
        : Math.abs(delta) > 135
          ? "Sharp turn"
          : delta > 0
            ? "Right"
            : "Left";

    return { text: `${dir}${onto} (${facing})`, metres: gp.metres };
  });
}

function gpx(name: string, coords: [number, number][]): string {
  const pts = coords
    .map(([lon, lat]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="scenic-route" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeXml(name)}</name>
    <desc>Generated by scenic-route. Basemap data © OpenStreetMap contributors (ODbL).</desc>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

const escapeHtml = (s: string) =>
  s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);

const mins = (s: number) => `${Math.round(s / 60)} min`;
const dist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

/** Inline SVG of the route shape — orientation without needing tiles or signal. */
function shapeSvg(scenic: [number, number][], fast: [number, number][]): string {
  const all = [...scenic, ...fast];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [lon, lat] of all) {
    if (lon < minX) minX = lon;
    if (lon > maxX) maxX = lon;
    if (lat < minY) minY = lat;
    if (lat > maxY) maxY = lat;
  }
  const k = Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
  const w = (maxX - minX) * k || 1e-6;
  const h = maxY - minY || 1e-6;
  const scale = 260 / Math.max(w, h);
  const px = ([lon, lat]: [number, number]) =>
    `${((lon - minX) * k * scale).toFixed(1)},${((maxY - lat) * scale).toFixed(1)}`;

  const line = (c: [number, number][], stroke: string, width: number, dash = "") =>
    `<polyline points="${c.map(px).join(" ")}" fill="none" stroke="${stroke}" stroke-width="${width}" ${dash} stroke-linejoin="round" stroke-linecap="round"/>`;

  return `<svg viewBox="-8 -8 ${w * scale + 16} ${h * scale + 16}" preserveAspectRatio="xMidYMid meet" style="width:100%;max-width:300px;max-height:300px">
    ${line(fast, "#94a3b8", 3, 'stroke-dasharray="4 4"')}
    ${line(scenic, "#059669", 4)}
    <circle cx="${px(scenic[0]).split(",")[0]}" cy="${px(scenic[0]).split(",")[1]}" r="5" fill="#0f172a"/>
    <circle cx="${px(scenic[scenic.length - 1]).split(",")[0]}" cy="${px(scenic[scenic.length - 1]).split(",")[1]}" r="5" fill="#dc2626"/>
  </svg>`;
}

async function main() {
  for (const f of ["graph.json", "scores.json"]) {
    if (!existsSync(path.join(DATA, f))) {
      console.error(`No data/${f}. Run the pipeline first.`);
      process.exit(1);
    }
  }

  const artifact = JSON.parse(readFileSync(path.join(DATA, "graph.json"), "utf8")) as GraphArtifact;
  const scores = JSON.parse(readFileSync(path.join(DATA, "scores.json"), "utf8")) as ScoreArtifact;
  const { walks } = JSON.parse(readFileSync(FIXTURES, "utf8")) as { walks: Walk[] };

  const g = buildRoutingGraph(artifact);
  const scratch = makeScratch(g);

  await mkdir(OUT, { recursive: true });
  const cards: string[] = [];

  for (const walk of walks) {
    const weights = { ...DEFAULT_WEIGHTS, ...(walk.weights ?? {}) };
    const core = scenicArray(scores.axes, g.edgeCount, weights);

    const layers: { layer: InterestLayer; weight: number }[] = [];
    for (const id of walk.interests ?? []) {
      const entry = DICTIONARY.find((d) => d.id === id || d.synonyms.includes(id));
      if (entry) layers.push({ layer: interestLayer(entry, artifact), weight: 0.6 });
    }
    const scenic = applyInterests(core, layers);

    const source = nearestNode(artifact, walk.from[0], walk.from[1]);
    const target = nearestNode(artifact, walk.to[0], walk.to[1]);
    const plan = planRoutes(g, scratch, { source, target, scenic, slackMin: walk.slackMin });
    if (!plan) {
      console.log(`✗ ${walk.name}: no route`);
      continue;
    }

    const fastest = plan.routes[0];
    const best = plan.routes.reduce((a, b) => (b.scenic > a.scenic ? b : a));

    const scenicCoords = coordinates(artifact, best);
    const fastCoords = coordinates(artifact, fastest);

    await writeFile(path.join(OUT, `${walk.id}.gpx`), gpx(`${walk.name} (scenic)`, scenicCoords));
    await writeFile(path.join(OUT, `${walk.id}-fast.gpx`), gpx(`${walk.name} (fastest)`, fastCoords));

    const steps = directions(artifact, best);
    const axisRow = (axis: (typeof SCENIC_AXES)[number]) => {
      let metres = 0;
      for (const e of best.edges) metres += (scores.axes[axis.key][e] ?? 0) * g.len[e];
      const pct = Math.round((metres / best.len) * 100);
      return `<tr><td>${axis.label}</td><td class="bar"><span style="width:${pct}%;background:${axis.color}"></span></td><td class="num">${pct}</td></tr>`;
    };

    const interestLines = layers
      .map(({ layer }) => {
        let m = 0;
        for (const e of best.edges) if (layer.scores.has(e)) m += g.len[e];
        return m > 0 ? `<p class="win">${dist(m)} of ${layer.label.toLowerCase()}</p>` : "";
      })
      .join("");

    const priorRatings = (walk.ratings ?? []).length
      ? `<p class="prior">Previously rated: ${(walk.ratings ?? [])
          .map((r) => `${r.rating}/5 (${r.date})`)
          .join(", ")}</p>`
      : "";

    cards.push(`
<section>
  <h2>${escapeHtml(walk.name)}</h2>
  <p class="tests"><strong>What this is testing.</strong> ${escapeHtml(walk.tests)}</p>
  ${priorRatings}
  <div class="row">
    <div class="shape">${shapeSvg(scenicCoords, fastCoords)}
      <p class="legend"><span class="sw green"></span>walk this &nbsp; <span class="sw grey"></span>fastest, for comparison</p>
    </div>
    <div class="stats">
      <p class="big">${mins(best.time)} &middot; ${dist(best.len)}</p>
      <p class="sub">${best.detour > 30 ? `+${mins(best.detour)} over the fastest route (${mins(fastest.time)})` : "same as the fastest route"}</p>
      ${interestLines}
      <table>${SCENIC_AXES.map(axisRow).join("")}</table>
      <p class="sub">GPX: <code>${walk.id}.gpx</code> &middot; fastest: <code>${walk.id}-fast.gpx</code></p>
    </div>
  </div>
  <h3>Directions</h3>
  <ol class="dirs">
    ${steps.map((s) => `<li><span>${escapeHtml(s.text)}</span> <em>${dist(s.metres)}</em></li>`).join("")}
  </ol>
  <div class="rate">
    <strong>How was it? 1&ndash;5</strong>
    <p>Record in <code>scripts/fixtures/walk-test.json</code> under
    <code>"${walk.id}"</code> &rarr; <code>ratings</code>, with today's date and a
    note about <em>why</em>. The note matters more than the number — "nice but
    the last third was a wind tunnel" is actionable, "3" isn't.</p>
  </div>
</section>`);

    console.log(
      `✓ ${walk.name.padEnd(42)} ${mins(best.time)} · ${dist(best.len)} · ` +
        `+${mins(best.detour)} · ${steps.length} steps`,
    );
  }

  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scenic Route — walk test</title>
<style>
  :root { color-scheme: light; }
  body { font: 15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         margin: 0 auto; max-width: 44rem; padding: 1.25rem; color: #0f172a; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 0 0 .5rem; }
  h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em;
       color: #64748b; margin: 1.25rem 0 .4rem; }
  .intro { color: #475569; margin: 0 0 1.5rem; }
  section { border: 1px solid #e2e8f0; border-radius: 10px; padding: 1rem;
            margin-bottom: 1.5rem; break-inside: avoid; }
  .tests { background: #f8fafc; border-left: 3px solid #94a3b8;
           padding: .5rem .75rem; margin: 0 0 .75rem; font-size: .88rem; color: #334155; }
  .prior { font-size: .85rem; color: #059669; margin: 0 0 .75rem; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-start; }
  .shape { flex: 0 0 auto; }
  .stats { flex: 1 1 14rem; min-width: 13rem; }
  .big { font-size: 1.25rem; font-weight: 600; margin: 0; }
  .sub { color: #64748b; font-size: .85rem; margin: .15rem 0 .5rem; }
  .win { color: #047857; font-weight: 600; margin: .15rem 0; font-size: .9rem; }
  .legend { font-size: .75rem; color: #64748b; margin: .35rem 0 0; }
  .sw { display: inline-block; width: 14px; height: 3px; vertical-align: middle; }
  .sw.green { background: #059669; } .sw.grey { background: #94a3b8; }
  table { width: 100%; border-collapse: collapse; font-size: .8rem; }
  td { padding: 1px 0; } td:first-child { color: #475569; width: 8.5rem; }
  .bar { width: auto; } .bar span { display: block; height: 5px; border-radius: 3px; }
  .num { width: 2rem; text-align: right; color: #94a3b8; font-variant-numeric: tabular-nums; }
  .dirs { margin: 0; padding-left: 1.3rem; font-size: .9rem; }
  .dirs li { margin: .1rem 0; }
  .dirs em { color: #64748b; font-style: normal; font-size: .85rem; }
  .dirs span { font-weight: 500; }
  .rate { margin-top: 1rem; padding-top: .75rem; border-top: 1px solid #e2e8f0;
          font-size: .85rem; color: #475569; }
  code { background: #f1f5f9; padding: .05rem .25rem; border-radius: 3px; font-size: .85em; }
  footer { color: #94a3b8; font-size: .78rem; margin-top: 2rem; }
  @media print { section { border-color: #cbd5e1; } .rate { display: none; } }
</style>
<h1>Walk test</h1>
<p class="intro">Three walks, each testing a different claim the scoring makes.
Load the GPX into whatever map app you use, or just follow the street list —
neither needs signal. Rate each one afterwards; a change that improves the
fixtures but makes a real walk worse is a change to revert.</p>
${cards.join("\n")}
<footer>Generated ${new Date().toLocaleString()} · routes from OpenStreetMap data, © OpenStreetMap contributors (ODbL)</footer>
`;

  await writeFile(path.join(OUT, "index.html"), html);
  console.log(`\n→ data/walk-test/  (index.html + ${walks.length * 2} GPX files)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
