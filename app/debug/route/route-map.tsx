"use client";

/**
 * Phase 2's verification surface (PLAN.md §12): two clicks on the map, three
 * lines back.
 *
 * The phase is done when "routes are visibly nicer than the straight line and
 * the α dial does something you can feel". So the controls that matter are the
 * axis weights and the slack slider — everything else on screen exists to make
 * the trade-off legible: each route's real walking time, what it costs over the
 * fastest, and how much of it is actually spent near the things you asked for.
 *
 * The MapLibre gotchas are the same ones documented in AGENTS.md — worker URL
 * before construction, layers on `styledata` not `load`, `h-full` not
 * `absolute inset-0`, and always wire `map.on("error")`.
 */
import { useEffect, useRef, useState } from "react";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { SCENIC_AXES, type ScenicAxis } from "@/lib/features";
import { PILOT } from "@/lib/pilot";

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)';

const SOURCE = "routes";
const LAYER = "routes-line";

type Pt = { lon: number; lat: number };

type ApiRoute = {
  id: number;
  alpha: number;
  time: number;
  detour: number;
  len: number;
  scenic: number;
  axes: Record<ScenicAxis, number>;
  geometry: { type: "LineString"; coordinates: [number, number][] };
};

type ApiResponse = {
  meta: {
    fastestTime: number;
    budget: number;
    alphaAtBudget: number;
    searches: number;
    ms: number;
  };
  routes: ApiRoute[];
};

/**
 * Fastest → greediest. Slate reads as "the baseline", and warmer means more
 * scenery bought, which matches how the score ramps read on the other page.
 */
const ROUTE_COLORS = ["#64748b", "#f59e0b", "#059669"];

const fmt = new Intl.NumberFormat("en-US");

function mins(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}

export default function RouteMap({ edges }: { edges: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);

  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<Pt | null>(null);
  const [destination, setDestination] = useState<Pt | null>(null);
  const [slackMin, setSlackMin] = useState(10);
  const [weights, setWeights] = useState<Record<ScenicAxis, number>>({
    green: 1, water: 1, architecture: 1, art: 1, quiet: 1, hills: 1,
  });
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  /**
   * Routing is driven from the handlers rather than an effect, with the current
   * request values passed in explicitly.
   *
   * Fetching here is a *reaction to user input*, not synchronisation with an
   * external system, which is what effects are for — and doing it in an effect
   * trips React 19's cascading-render rule, since `setPending(true)` would run
   * synchronously in the effect body. Taking the values as arguments also
   * avoids reading stale state from a closure when the slider fires several
   * times in quick succession.
   */
  const requestId = useRef(0);

  async function runRoute(
    o: Pt,
    d: Pt,
    slack: number,
    w: Record<ScenicAxis, number>,
  ) {
    const id = ++requestId.current;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: o,
          destination: d,
          slackMin: slack,
          weights: w,
        }),
      });
      const body = await res.json();
      // Dragging the slider leaves several requests in flight; only the newest
      // may write, or the map lands on whichever happened to be slowest.
      if (id !== requestId.current) return;
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setResult(body as ApiResponse);
    } catch (err) {
      if (id !== requestId.current) return;
      setError((err as Error).message);
      setResult(null);
    } finally {
      if (id === requestId.current) setPending(false);
    }
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

    const map = new MapLibreMap({
      container,
      style: STYLE_URL,
      bounds: [
        [PILOT.bbox.west, PILOT.bbox.south],
        [PILOT.bbox.east, PILOT.bbox.north],
      ],
      fitBoundsOptions: { padding: 24 },
      hash: true,
    });
    mapRef.current = map;

    map.on("error", (e) => {
      const message = e.error?.message ?? String(e);
      console.error("[maplibre]", message);
      setMapError(message);
    });

    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");

    // `styledata`, not `load` — see AGENTS.md.
    const addLayers = () => {
      if (map.getSource(SOURCE)) return;
      map.addSource(SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution: OSM_ATTRIBUTION,
      });
      map.addLayer({
        id: LAYER,
        type: "line",
        source: SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            11, ["case", ["get", "active"], 5, 3],
            16, ["case", ["get", "active"], 9, 5],
          ],
          "line-opacity": ["case", ["get", "active"], 1, 0.75],
        },
      });
      setReady(true);
    };
    if (map.isStyleLoaded()) addLayers();
    else map.on("styledata", addLayers);

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Click sets origin, then destination, then starts over.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const onClick = (e: { lngLat: { lng: number; lat: number } }) => {
      const pt = { lon: e.lngLat.lng, lat: e.lngLat.lat };
      setError(null);
      if (!origin || destination) {
        setOrigin(pt);
        setDestination(null);
        setResult(null);
      } else {
        setDestination(pt);
        void runRoute(origin, pt, slackMin, weights);
      }
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [ready, origin, destination, slackMin, weights, runRoute]);

  // Markers follow the two points.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    for (const [pt, color] of [
      [origin, "#0f172a"],
      [destination, "#dc2626"],
    ] as const) {
      if (!pt) continue;
      markersRef.current.push(
        new Marker({ color }).setLngLat([pt.lon, pt.lat]).addTo(map),
      );
    }
  }, [ready, origin, destination]);

  /**
   * Draw. Routes come back fastest-first, so the last one is the greediest —
   * it's the one highlighted by default, since it's the answer to what the
   * user actually asked for. Hovering a row in the panel promotes that one
   * instead.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(SOURCE);
    if (!source || !("setData" in source)) return;

    const routes = result?.routes ?? [];
    const highlighted = hovered ?? routes.length - 1;

    (source as { setData: (d: unknown) => void }).setData({
      type: "FeatureCollection",
      features: routes.map((r, i) => ({
        type: "Feature" as const,
        properties: {
          color: ROUTE_COLORS[i] ?? "#64748b",
          active: i === highlighted,
        },
        geometry: r.geometry,
      })),
    });
  }, [ready, result, hovered]);

  function toggleAxis(axis: ScenicAxis) {
    const next = { ...weights, [axis]: weights[axis] > 0 ? 0 : 1 };
    setWeights(next);
    if (origin && destination) void runRoute(origin, destination, slackMin, next);
  }

  function changeSlack(value: number) {
    setSlackMin(value);
    if (origin && destination) void runRoute(origin, destination, value, weights);
  }

  const anyWeight = Object.values(weights).some((w) => w > 0);

  return (
    <div className="relative h-dvh w-full font-sans text-slate-900">
      <div ref={containerRef} className="h-full w-full" />

      <header className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start gap-3 p-3">
        <div className="pointer-events-auto rounded-lg border border-slate-200 bg-white/90 px-3 py-2 shadow-sm backdrop-blur">
          <h1 className="text-sm font-semibold">Router · {PILOT.name}</h1>
          <p className="mt-0.5 text-xs text-slate-600">
            {!origin
              ? "Click to set the start."
              : !destination
                ? "Now click the destination."
                : "Click again to start over."}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">
            {fmt.format(edges)} edges
            {result &&
              ` · ${result.meta.searches} searches · ${result.meta.ms} ms`}
          </p>
        </div>

        {pending && (
          <div className="pointer-events-auto rounded-lg border border-slate-200 bg-white/90 px-3 py-2 text-xs shadow-sm">
            Routing…
          </div>
        )}
        {error && (
          <div className="pointer-events-auto max-w-sm rounded-lg border border-red-200 bg-red-50/95 px-3 py-2 text-xs text-red-800 shadow-sm">
            {error}
          </div>
        )}
        {mapError && (
          <div className="pointer-events-auto max-w-sm rounded-lg border border-red-200 bg-red-50/95 px-3 py-2 text-xs text-red-800 shadow-sm">
            <strong className="font-semibold">Map:</strong> {mapError}
          </div>
        )}
      </header>

      <div className="absolute bottom-3 left-3 max-h-[80vh] w-72 overflow-y-auto rounded-lg border border-slate-200 bg-white/90 p-3 shadow-sm backdrop-blur">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          What makes a walk good
        </h2>
        <ul className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1">
          {SCENIC_AXES.map((axis) => (
            <li key={axis.key}>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={weights[axis.key] > 0}
                  onChange={() => toggleAxis(axis.key)}
                  className="size-3.5 accent-slate-700"
                />
                <span
                  className="h-1 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: axis.color }}
                />
                <span className={weights[axis.key] > 0 ? "" : "text-slate-400"}>
                  {axis.label.split(" ")[0]}
                </span>
              </label>
            </li>
          ))}
        </ul>
        {!anyWeight && (
          <p className="mt-2 text-[11px] text-amber-700">
            Nothing selected — every route is just the fastest one.
          </p>
        )}

        <label className="mt-3 block border-t border-slate-200 pt-2 text-[11px] text-slate-600">
          I&apos;ll spend up to{" "}
          <span className="font-mono font-semibold text-slate-900">
            +{slackMin} min
          </span>
          <input
            type="range"
            min={0}
            max={45}
            step={1}
            value={slackMin}
            onChange={(e) => changeSlack(Number(e.target.value))}
            className="mt-1 w-full accent-slate-700"
          />
        </label>

        {result && (
          <>
            <div className="mt-3 border-t border-slate-200 pt-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Routes
              </h2>
              <ul className="mt-2 space-y-2">
                {result.routes.map((r, i) => (
                  <li
                    key={r.id}
                    onMouseEnter={() => setHovered(i)}
                    onMouseLeave={() => setHovered(null)}
                    className="cursor-default rounded-md border border-slate-200 p-2 hover:border-slate-400"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-1.5 w-5 shrink-0 rounded-full"
                        style={{ backgroundColor: ROUTE_COLORS[i] }}
                      />
                      <span className="text-xs font-semibold">
                        {mins(r.time)}
                      </span>
                      {/*
                        Only the α=0 route is *the* fastest. Rounding anything
                        under half a minute to "fastest" made two routes claim
                        the title, which is exactly the comparison this panel
                        exists to make legible.
                      */}
                      <span className="text-[11px] text-slate-500">
                        {r.detour === 0
                          ? "fastest"
                          : r.detour < 60
                            ? `+${Math.round(r.detour)}s`
                            : `+${mins(r.detour)}`}
                      </span>
                      <span className="ml-auto font-mono text-[10px] text-slate-400">
                        α{r.alpha.toFixed(2)}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-slate-600">
                      {(r.len / 1000).toFixed(2)} km · scenic{" "}
                      {r.scenic.toFixed(2)}
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {SCENIC_AXES.filter((a) => weights[a.key] > 0).map((a) => (
                        <li
                          key={a.key}
                          className="flex items-center gap-1.5 text-[10px]"
                        >
                          <span className="w-14 shrink-0 text-slate-500">
                            {a.label.split(" ")[0]}
                          </span>
                          <span className="h-1 flex-1 rounded-full bg-slate-100">
                            <span
                              className="block h-1 rounded-full"
                              style={{
                                width: `${Math.round(r.axes[a.key] * 100)}%`,
                                backgroundColor: a.color,
                              }}
                            />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
            <p className="mt-2 text-[10px] text-slate-400">
              budget {mins(result.meta.budget)} · greediest α that fit:{" "}
              {result.meta.alphaAtBudget.toFixed(3)}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
