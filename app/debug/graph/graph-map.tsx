"use client";

/**
 * The Phase 0–1 verification surface (PLAN.md §13).
 *
 * Phase 0 asked "is this the right network?" — colour by road class, click for
 * raw OSM tags. Phase 1 asks the question the whole product rests on: **does
 * the scenic score agree with what I know about this city?** Riverside Park,
 * the Brooklyn Heights Promenade and the Hudson River Greenway should glow.
 * 8th Avenue should not. If that doesn't hold, no amount of routing
 * sophistication in Phase 2 rescues it.
 *
 * The threshold slider is what makes that a sharp check rather than a squint:
 * pushed to the top decile, only the streets the scorer is genuinely confident
 * about stay on the map, and you can see immediately whether they're the ones
 * you'd actually walk.
 *
 * Note maplibre-gl v6 has no default export; everything is a named import.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type AddLayerObject,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  EDGE_CLASSES,
  type ClassSummary,
  type EdgeClass,
  type GraphMeta,
} from "@/lib/graph";
import {
  OVERALL_RAMP,
  RAMP_STOPS,
  SCENIC_AXES,
  type ScenicAxis,
} from "@/lib/features";
import type { ScoreMeta } from "@/lib/scoring";
import { PILOT } from "@/lib/pilot";

const SOURCE = "graph";
const EDGE_LAYER = "graph-edges";
/** Invisible, fat, and only there to be clicked — see where it's added. */
const HIT_LAYER = "graph-hit";
const SELECTED_LAYER = "graph-selected";

/** OpenFreeMap: free, keyless, and pale enough that coloured edges stay readable. */
const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)';

/** Score properties, matching AXIS_PROPERTY in lib/graph-server.ts. */
const AXIS_PROPERTY: Record<ScenicAxis, string> = {
  green: "gr",
  water: "wa",
  architecture: "ar",
  art: "la",
  quiet: "qu",
  hills: "hi",
};

const COMPOSITE = "composite" as const;
type View = typeof COMPOSITE | ScenicAxis;

type EdgeProps = {
  i: number;
  c: EdgeClass;
  l: number;
  s: number;
  t: number;
  scores: Record<string, number>;
};

type LineLayer = Extract<AddLayerObject, { type: "line" }>;
type LinePaint = NonNullable<LineLayer["paint"]>;
type LineColor = NonNullable<LinePaint["line-color"]>;
type LineWidth = NonNullable<LinePaint["line-width"]>;
/** maplibre-gl v6 doesn't re-export FilterSpecification, so derive it. */
type MapFilter = NonNullable<Parameters<MapLibreMap["setFilter"]>[1]>;

/**
 * `["match", ["get","c"], key, colour, …, fallback]`, built from EDGE_CLASSES so
 * the legend and the map can't drift apart. TypeScript can't check the arity of
 * a spread-built match expression, which is what the cast is for.
 */
const COLOR_BY_CLASS = [
  "match",
  ["get", "c"],
  ...EDGE_CLASSES.flatMap((c) => [c.key, c.color]),
  "#000000",
] as unknown as LineColor;

/**
 * Scores arrive as integers 0–100 with zeros omitted, so every read needs the
 * coalesce — a missing property means "scored zero", not "no data".
 */
function scoreExpression(view: View) {
  const prop = view === COMPOSITE ? "sc" : AXIS_PROPERTY[view];
  return ["coalesce", ["get", prop], 0];
}

/**
 * The ramp for a view: each axis is tinted with its own hue (green for green,
 * blue for water) so the map matches the legend swatch and the score bars in
 * the edge panel, while the composite stays a neutral heat ramp. Definitions
 * live in lib/features.ts beside the axis colours.
 *
 * All ramps share the same pale slate at zero, so a low score recedes into the
 * basemap in every view and only the high end carries the hue — the brightness
 * still reads as "how strong is this", whichever axis you're on.
 */
function rampFor(view: View): readonly string[] {
  if (view === COMPOSITE) return OVERALL_RAMP;
  return SCENIC_AXES.find((a) => a.key === view)!.ramp;
}

function colorByScore(view: View): LineColor {
  const ramp = rampFor(view);
  return [
    "interpolate",
    ["linear"],
    scoreExpression(view),
    ...RAMP_STOPS.flatMap((stop, i) => [stop, ramp[i]]),
  ] as unknown as LineColor;
}

/** High scorers draw thicker as well as hotter, so they read at low zoom. */
function widthByScore(view: View): LineWidth {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    10,
    ["interpolate", ["linear"], scoreExpression(view), 0, 0.3, 100, 1.6],
    13,
    ["interpolate", ["linear"], scoreExpression(view), 0, 0.6, 100, 2.4],
    16,
    ["interpolate", ["linear"], scoreExpression(view), 0, 1.4, 100, 4.5],
    19,
    ["interpolate", ["linear"], scoreExpression(view), 0, 3.5, 100, 9],
  ] as unknown as LineWidth;
}

const WIDTH_BY_ZOOM = [
  "interpolate",
  ["linear"],
  ["zoom"],
  10,
  0.4,
  13,
  0.9,
  16,
  2,
  19,
  5,
] as unknown as LineWidth;

const fmt = new Intl.NumberFormat("en-US");

function walkTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function GraphMap({
  meta,
  summary,
  scoreMeta,
  scoreProblem,
}: {
  meta: GraphMeta;
  summary: ClassSummary[];
  scoreMeta: ScoreMeta | null;
  scoreProblem: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  const [layersReady, setLayersReady] = useState(false);
  const [edgesDrawn, setEdgesDrawn] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<EdgeClass>>(new Set());
  const [selected, setSelected] = useState<EdgeProps | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  /** Scenic colouring is only meaningful once there are scores to colour by. */
  const [view, setView] = useState<View | null>(scoreMeta ? COMPOSITE : null);
  const [threshold, setThreshold] = useState(0);

  const [tagState, setTagState] = useState<{
    t: number;
    tags?: Record<string, string>;
    error?: string;
  } | null>(null);

  const visible = useMemo(
    () => EDGE_CLASSES.map((c) => c.key).filter((k) => !hidden.has(k)),
    [hidden],
  );
  const visibleKey = visible.join(",");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // MapLibre would otherwise derive this from `import.meta.url`, which points
    // into Turbopack's chunk directory — the worker 404s and every tile request
    // hangs with no error at all. scripts/copy-map-worker.ts puts it here.
    setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

    const map = new MapLibreMap({
      container,
      style: STYLE_URL,
      bounds: [
        [PILOT.bbox.west, PILOT.bbox.south],
        [PILOT.bbox.east, PILOT.bbox.north],
      ],
      fitBoundsOptions: { padding: 24 },
      // You reload this page constantly while staring at the same three
      // blocks; the hash keeps the view across reloads.
      hash: true,
    });
    mapRef.current = map;

    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __map?: MapLibreMap }).__map = map;
    }

    // Without this a failed style or tile fetch is an empty grey rectangle and
    // nothing else — the whole point of the page is seeing what went wrong.
    map.on("error", (e) => {
      const message = e.error?.message ?? String(e);
      console.error("[maplibre]", message);
      setMapError(message);
    });

    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");

    /**
     * Deliberately not `map.on("load")`: that fires only after the style *and*
     * every source it declares are ready and a first frame has rendered, so a
     * slow basemap source — or a browser tab that isn't painting — leaves the
     * graph layers permanently unadded. `styledata` fires as soon as the
     * stylesheet is applied, which is all we need to attach a source to. It
     * fires repeatedly, hence the idempotence guard.
     */
    const addGraphLayers = () => {
      if (map.getSource(SOURCE)) return;

      map.addSource(SOURCE, {
        type: "geojson",
        // A URL, not inline data: MapLibre fetches and parses ~30 MB in its
        // worker, off the main thread.
        data: "/api/debug/graph",
        attribution: OSM_ATTRIBUTION,
      });

      map.addLayer({
        id: EDGE_LAYER,
        type: "line",
        source: SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": COLOR_BY_CLASS,
          "line-width": WIDTH_BY_ZOOM,
          "line-opacity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            0.75,
            14,
            1,
          ],
        },
      });

      // Edges draw 2px wide at street zoom, which means clicking one demands
      // pixel-perfect aim. A transparent fat line over the top is still
      // hit-testable, so the click target is ~14px while the map stays honest
      // about how wide a street actually is.
      map.addLayer({
        id: HIT_LAYER,
        type: "line",
        source: SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#000000", "line-opacity": 0, "line-width": 14 },
      });

      map.addLayer({
        id: SELECTED_LAYER,
        type: "line",
        source: SOURCE,
        filter: ["==", ["get", "i"], -1],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#0f172a",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            2.5,
            16,
            6,
            19,
            11,
          ],
        },
      });

      setLayersReady(true);
    };

    if (map.isStyleLoaded()) addGraphLayers();
    else map.on("styledata", addGraphLayers);

    map.on("sourcedata", (e) => {
      if (e.sourceId === SOURCE && e.isSourceLoaded) setEdgesDrawn(true);
    });

    map.on("click", HIT_LAYER, (e) => {
      const props = e.features?.[0]?.properties;
      if (!props) return;
      const scores: Record<string, number> = {};
      for (const key of ["sc", ...Object.values(AXIS_PROPERTY)]) {
        scores[key] = Number(props[key] ?? 0);
      }
      setSelected({
        i: Number(props.i),
        c: String(props.c) as EdgeClass,
        l: Number(props.l),
        s: Number(props.s),
        t: Number(props.t),
        scores,
      });
    });

    // A click that hits no edge clears the panel.
    map.on("click", (e) => {
      if (!map.getLayer(HIT_LAYER)) return;
      const hits = map.queryRenderedFeatures(e.point, { layers: [HIT_LAYER] });
      if (hits.length === 0) setSelected(null);
    });

    map.on("mouseenter", HIT_LAYER, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", HIT_LAYER, () => {
      map.getCanvas().style.cursor = "";
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Colour and width follow the selected view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    if (view === null) {
      map.setPaintProperty(EDGE_LAYER, "line-color", COLOR_BY_CLASS);
      map.setPaintProperty(EDGE_LAYER, "line-width", WIDTH_BY_ZOOM);
    } else {
      map.setPaintProperty(EDGE_LAYER, "line-color", colorByScore(view));
      map.setPaintProperty(EDGE_LAYER, "line-width", widthByScore(view));
    }
  }, [layersReady, view]);

  // Class visibility and the score threshold are one combined filter — the hit
  // layer gets it too, so anything hidden isn't silently still clickable.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;

    const clauses: unknown[] = [
      "in",
      ["get", "c"],
      ["literal", visibleKey.split(",").filter(Boolean)],
    ];
    const filter: MapFilter =
      view !== null && threshold > 0
        ? ([
            "all",
            clauses,
            [">=", scoreExpression(view), threshold],
          ] as unknown as MapFilter)
        : (clauses as unknown as MapFilter);

    map.setFilter(EDGE_LAYER, filter);
    map.setFilter(HIT_LAYER, filter);
  }, [layersReady, visibleKey, view, threshold]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    map.setFilter(SELECTED_LAYER, ["==", ["get", "i"], selected?.i ?? -1]);
  }, [layersReady, selected]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const t = selected.t;
    fetch(`/api/debug/tags/${t}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((tags: Record<string, string>) => setTagState({ t, tags }))
      .catch((err: Error) => {
        if (err.name !== "AbortError") setTagState({ t, error: err.message });
      });
    return () => controller.abort();
  }, [selected]);

  const shownTags = selected && tagState?.t === selected.t ? tagState : null;

  function toggle(key: EdgeClass) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="relative h-dvh w-full font-sans text-slate-900">
      {/*
        Sized with h-full rather than `absolute inset-0`: maplibre's stylesheet
        sets `.maplibregl-map { position: relative }` and loads after Tailwind,
        which would win and collapse the container to zero height.
      */}
      <div ref={containerRef} className="h-full w-full" />

      <header className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start gap-3 p-3">
        <div className="pointer-events-auto rounded-lg border border-slate-200 bg-white/90 px-3 py-2 shadow-sm backdrop-blur">
          <h1 className="text-sm font-semibold">
            {view === null ? "Walkable graph" : "Scenic score"} · {PILOT.name}
          </h1>
          <p className="mt-0.5 font-mono text-xs text-slate-600">
            {fmt.format(meta.edges)} edges · {fmt.format(meta.nodes)} nodes ·{" "}
            {fmt.format(meta.totalKm)} km
          </p>
          {scoreMeta && (
            <p className="mt-0.5 font-mono text-[11px] text-slate-500">
              {fmt.format(scoreMeta.sources.osm ?? 0)} OSM features ·{" "}
              {fmt.format(scoreMeta.sources.streetTrees ?? 0)} trees ·{" "}
              {fmt.format(scoreMeta.sources.historicDistricts ?? 0)} districts
            </p>
          )}
        </div>

        {!edgesDrawn && !mapError && (
          <div className="pointer-events-auto rounded-lg border border-slate-200 bg-white/90 px-3 py-2 text-xs shadow-sm backdrop-blur">
            Loading {fmt.format(meta.edges)} edges…
          </div>
        )}

        {scoreProblem && (
          <div className="pointer-events-auto max-w-sm rounded-lg border border-amber-200 bg-amber-50/95 px-3 py-2 text-xs text-amber-900 shadow-sm">
            {scoreProblem}
          </div>
        )}

        {mapError && (
          <div className="pointer-events-auto max-w-sm rounded-lg border border-red-200 bg-red-50/95 px-3 py-2 text-xs text-red-800 shadow-sm">
            <strong className="font-semibold">Map error:</strong> {mapError}
          </div>
        )}
      </header>

      <div className="absolute bottom-3 left-3 max-h-[75vh] w-64 overflow-y-auto rounded-lg border border-slate-200 bg-white/90 p-3 shadow-sm backdrop-blur">
        {scoreMeta && (
          <>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Colour by
            </h2>
            <ul className="mt-2 space-y-1">
              <ViewOption
                label="Scenic score"
                bold
                active={view === COMPOSITE}
                onSelect={() => setView(COMPOSITE)}
              />
              {SCENIC_AXES.map((axis) => (
                <ViewOption
                  key={axis.key}
                  label={axis.label}
                  swatch={axis.color}
                  active={view === axis.key}
                  onSelect={() => setView(axis.key)}
                />
              ))}
              <ViewOption
                label="Road class"
                active={view === null}
                onSelect={() => setView(null)}
              />
            </ul>

            {view !== null && (
              <div className="mt-3 border-t border-slate-200 pt-2">
                <div
                  className="h-2 w-full rounded-full"
                  style={{
                    backgroundImage: `linear-gradient(to right, ${RAMP_STOPS.map(
                      (stop, i) => `${rampFor(view)[i]} ${stop}%`,
                    ).join(", ")})`,
                  }}
                />
                <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
                  <span>0</span>
                  <span>percentile</span>
                  <span>100</span>
                </div>

                <label className="mt-2 block text-[11px] text-slate-600">
                  Hide below{" "}
                  <span className="font-mono font-semibold">{threshold}</span>
                  <input
                    type="range"
                    min={0}
                    max={95}
                    step={5}
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                    className="mt-1 w-full accent-slate-700"
                  />
                </label>
              </div>
            )}
          </>
        )}

        <div className={scoreMeta ? "mt-3 border-t border-slate-200 pt-2" : ""}>
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Road class
            </h2>
            <button
              type="button"
              onClick={() => setHidden(new Set())}
              className="text-[11px] text-slate-500 underline underline-offset-2 hover:text-slate-900"
            >
              show all
            </button>
          </div>

          <ul className="mt-2 space-y-1">
            {summary.map((row) => {
              const cls = EDGE_CLASSES.find((c) => c.key === row.key)!;
              const on = !hidden.has(row.key);
              return (
                <li key={row.key}>
                  <label className="flex cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(row.key)}
                      className="size-3.5 accent-slate-700"
                    />
                    <span
                      className="h-1 w-4 shrink-0 rounded-full"
                      style={{
                        backgroundColor: cls.color,
                        opacity: on ? 1 : 0.3,
                      }}
                    />
                    <span className={on ? "" : "text-slate-400"}>
                      {cls.label}
                    </span>
                    <span className="ml-auto font-mono text-[11px] text-slate-500">
                      {fmt.format(row.km)} km
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>

        <p className="mt-3 border-t border-slate-200 pt-2 text-[11px] text-slate-500">
          Click an edge for its scores and raw OSM tags.
        </p>
      </div>

      {selected && (
        <aside className="absolute right-3 top-16 max-h-[70vh] w-80 overflow-y-auto rounded-lg border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Edge {selected.i}</h2>
              <p className="mt-0.5 font-mono text-xs text-slate-600">
                {fmt.format(Math.round(selected.l))} m · {walkTime(selected.s)} ·{" "}
                {EDGE_CLASSES.find((c) => c.key === selected.c)?.label}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-900"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {scoreMeta && (
            <>
              <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Scenic score{" "}
                <span className="font-mono text-slate-900">
                  {selected.scores.sc}
                </span>
              </h3>
              <ul className="mt-2 space-y-1">
                {SCENIC_AXES.map((axis) => {
                  const v = selected.scores[AXIS_PROPERTY[axis.key]] ?? 0;
                  return (
                    <li
                      key={axis.key}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span className="w-28 shrink-0 text-slate-600">
                        {axis.label}
                      </span>
                      <span className="h-1.5 flex-1 rounded-full bg-slate-100">
                        <span
                          className="block h-1.5 rounded-full"
                          style={{
                            width: `${v}%`,
                            backgroundColor: axis.color,
                          }}
                        />
                      </span>
                      <span className="w-6 text-right font-mono text-[11px] text-slate-500">
                        {v}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            OSM tags · way set {selected.t}
          </h3>

          {shownTags?.error && (
            <p className="mt-2 text-xs text-red-600">{shownTags.error}</p>
          )}
          {!shownTags && <p className="mt-2 text-xs text-slate-500">Loading…</p>}
          {shownTags?.tags && (
            <table className="mt-2 w-full table-fixed border-collapse text-xs">
              <tbody>
                {Object.entries(shownTags.tags).map(([k, v]) => (
                  <tr key={k} className="border-t border-slate-100 align-top">
                    <td className="w-2/5 break-words py-1 pr-2 font-mono text-slate-500">
                      {k}
                    </td>
                    <td className="break-words py-1 font-mono">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </aside>
      )}
    </div>
  );
}

function ViewOption({
  label,
  swatch,
  bold,
  active,
  onSelect,
}: {
  label: string;
  swatch?: string;
  bold?: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="radio"
          name="view"
          checked={active}
          onChange={onSelect}
          className="size-3.5 accent-slate-700"
        />
        {swatch ? (
          <span
            className="h-1 w-4 shrink-0 rounded-full"
            style={{ backgroundColor: swatch }}
          />
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className={bold ? "font-semibold" : ""}>{label}</span>
      </label>
    </li>
  );
}
