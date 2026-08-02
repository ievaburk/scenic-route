"use client";

/**
 * Phase 0's verification surface (PLAN.md §13): the whole walkable graph on a
 * map, coloured by road class, with every edge's raw OSM tags one click away.
 *
 * The question it exists to answer is "is this the right network?" — are the
 * avenues avenues, do the park paths exist, did the Brooklyn Heights Promenade
 * survive the build. Phase 1 keeps this page and swaps the colouring to the
 * scenic score.
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

/** Properties carried on every feature — single letters to keep 170k of them small. */
type EdgeProps = { i: number; c: EdgeClass; l: number; s: number; t: number };

type LineLayer = Extract<AddLayerObject, { type: "line" }>;
type LineColor = NonNullable<NonNullable<LineLayer["paint"]>["line-color"]>;
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

const fmt = new Intl.NumberFormat("en-US");

function walkTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function GraphMap({
  meta,
  summary,
}: {
  meta: GraphMeta;
  summary: ClassSummary[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  const [layersReady, setLayersReady] = useState(false);
  const [edgesDrawn, setEdgesDrawn] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<EdgeClass>>(new Set());
  const [selected, setSelected] = useState<EdgeProps | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  /**
   * Keyed by tag-set index, so a slow response landing after you've clicked
   * elsewhere is ignored rather than shown under the wrong edge.
   */
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
        // A URL, not inline data: MapLibre fetches and parses ~25 MB in its
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
          "line-width": [
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
          ],
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
          "line-color": "#ec4899",
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
      setSelected({
        i: Number(props.i),
        c: String(props.c) as EdgeClass,
        l: Number(props.l),
        s: Number(props.s),
        t: Number(props.t),
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    const filter: MapFilter = [
      "in",
      ["get", "c"],
      ["literal", visibleKey.split(",").filter(Boolean)],
    ];
    // The hit layer gets the same filter, so a class you've hidden isn't
    // silently still clickable.
    map.setFilter(EDGE_LAYER, filter);
    map.setFilter(HIT_LAYER, filter);
  }, [layersReady, visibleKey]);

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
          <h1 className="text-sm font-semibold">Walkable graph · {PILOT.name}</h1>
          <p className="mt-0.5 font-mono text-xs text-slate-600">
            {fmt.format(meta.edges)} edges · {fmt.format(meta.nodes)} nodes ·{" "}
            {fmt.format(meta.totalKm)} km
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            built {new Date(meta.builtAt).toLocaleString()}
          </p>
        </div>

        {!edgesDrawn && !mapError && (
          <div className="pointer-events-auto rounded-lg border border-slate-200 bg-white/90 px-3 py-2 text-xs shadow-sm backdrop-blur">
            Loading {fmt.format(meta.edges)} edges…
          </div>
        )}

        {mapError && (
          <div className="pointer-events-auto max-w-sm rounded-lg border border-red-200 bg-red-50/95 px-3 py-2 text-xs text-red-800 shadow-sm">
            <strong className="font-semibold">Map error:</strong> {mapError}
          </div>
        )}
      </header>

      <div className="absolute bottom-3 left-3 max-h-[60vh] w-64 overflow-y-auto rounded-lg border border-slate-200 bg-white/90 p-3 shadow-sm backdrop-blur">
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
                    style={{ backgroundColor: cls.color, opacity: on ? 1 : 0.3 }}
                  />
                  <span className={on ? "" : "text-slate-400"}>{cls.label}</span>
                  <span className="ml-auto font-mono text-[11px] text-slate-500">
                    {fmt.format(row.km)} km
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <p className="mt-3 border-t border-slate-200 pt-2 text-[11px] text-slate-500">
          Click an edge for its raw OSM tags.
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
