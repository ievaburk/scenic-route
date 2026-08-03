"use client";

/**
 * Loop mode — the first surface a stranger could actually use (PLAN.md §12).
 *
 * Everything else in this repo is a debug view with the machinery on display.
 * This isn't: the α dial, the axis weights and the edge scores are all still
 * doing the work, they're just none of the walker's business. What's left on
 * screen is the request (how long, from where, what you like) and the answer
 * (three walks, and why each one is worth the time).
 *
 * §4 is specific that the breakdown *is* the product — "48 min · 2 parks ·
 * 1.1 km along the water" is what makes the time feel bought rather than lost.
 * So the card leads with duration and reasons, not with a score.
 *
 * The usual MapLibre traps are in AGENTS.md: worker URL before construction,
 * layers on `styledata` not `load`, `h-full` never `absolute inset-0`, and
 * always wire `map.on("error")`.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { SCENIC_AXES, type ScenicAxis } from "@/lib/features";
import {
  choicesSnapshot,
  deleteWalk,
  effectiveWeights,
  noWalksSnapshot,
  recordChoice,
  savedSnapshot,
  saveWalk,
  subscribe,
  walkToGpx,
  type Prefs,
  type SavedWalk,
} from "@/lib/prefs";
import { featureVector, shuffled } from "@/lib/learning";

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)';

const SOURCE = "loops";
const LAYER = "loops-line";
const LAYER_ACTIVE = "loops-line-active";

const DURATIONS = [20, 40, 60];
const LOOP_COLORS = ["#059669", "#0284c7", "#b45309"];

type Pt = { lon: number; lat: number };

/**
 * A walk, whichever mode produced it. `onTarget` is loop-only, `detour`
 * A-to-B-only; everything the card needs is common to both.
 */
type Walk = {
  id: number;
  time: number;
  len: number;
  scenic: number;
  axes: Record<ScenicAxis, number>;
  interests: { id: string; label: string; metres: number }[];
  geometry: { type: "LineString"; coordinates: [number, number][] };
  /** Loop mode: did it hit the requested duration? */
  onTarget?: boolean;
  /** A-to-B: seconds over the fastest route. 0 is the baseline. */
  detour?: number;
  /** Position in the engine's own ordering, before the display shuffle. */
  rank?: number;
};

type ApiResponse = {
  query: {
    interests: {
      phrase: string;
      status: string;
      label?: string;
      matchCount?: number;
      coverage?: string;
    }[];
  };
  walks: Walk[];
};

const fmt = new Intl.NumberFormat("en-US");
const km = (m: number) => `${(m / 1000).toFixed(1)} km`;

/**
 * The reasons this walk is worth the time, in plain language.
 *
 * §4's example is "2 parks · 1.1 km along the water · crosses 3 bridges". We
 * don't have named features yet — the score artifact keeps numbers, not
 * identities — so this says how *much* of the walk is near each thing rather
 * than naming them. Interests come first because they're what the walker
 * explicitly asked for, and seeing your own request reflected back is the
 * moment the app proves it listened.
 */
function reasons(loop: Walk): string[] {
  const out: string[] = [];

  for (const i of loop.interests) {
    if (i.metres >= 100) out.push(`${km(i.metres)} of ${i.label.toLowerCase()}`);
  }

  const axisPhrases: Partial<Record<ScenicAxis, string>> = {
    water: "along the water",
    green: "through green",
    architecture: "past old buildings",
    art: "past art and landmarks",
    quiet: "on quiet streets",
    hills: "with views",
  };
  const ranked = SCENIC_AXES.map((a) => ({ axis: a, v: loop.axes[a.key] ?? 0 }))
    .sort((a, b) => b.v - a.v)
    .filter((x) => x.v >= 0.35)
    .slice(0, 3);

  for (const { axis, v } of ranked) {
    const phrase = axisPhrases[axis.key];
    if (phrase) out.push(`${km(loop.len * v)} ${phrase}`);
  }

  return out.slice(0, 4);
}

export default function LoopMap({
  prefs,
  onEditPrefs,
  onPrefsChange,
}: {
  prefs: Prefs;
  onEditPrefs: () => void;
  onPrefsChange: (p: Prefs) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const requestId = useRef(0);

  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<Pt | null>(null);
  /** Set only in A-to-B mode. */
  const [destination, setDestination] = useState<Pt | null>(null);
  const [mode, setMode] = useState<"loop" | "ab">("loop");
  const [duration, setDuration] = useState(40);
  /**
   * §8's slider, in the only unit a walker can calibrate: minutes over the
   * fastest way there. Anchored against the fastest route, which is computed
   * first and always shown as the baseline.
   */
  const [slackMin, setSlackMin] = useState(10);
  const saved = useSyncExternalStore(subscribe, savedSnapshot, noWalksSnapshot);
  const [showSaved, setShowSaved] = useState(false);
  const interests = prefs.interests;
  const [seed, setSeed] = useState(0);
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * One fetch for both modes.
   *
   * The two endpoints answer genuinely different questions — a loop has a
   * duration target and no baseline, an A-to-B route has a baseline and a
   * detour budget — but the *card* is the same either way, because what the
   * walker wants to know is the same: how long, and why is it worth it. So the
   * responses are normalised to one shape here rather than forking the UI.
   */
  async function findWalks(opts: {
    mode: "loop" | "ab";
    origin: Pt;
    destination?: Pt | null;
    durationMin: number;
    slackMin: number;
    interests: string[];
    seed: number;
  }) {
    const id = ++requestId.current;
    setPending(true);
    setError(null);
    try {
      const isLoop = opts.mode === "loop";
      const res = await fetch(isLoop ? "/api/loop" : "/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isLoop
            ? {
                origin: opts.origin,
                durationMin: opts.durationMin,
                interests: opts.interests,
                weights: effectiveWeights(prefs),
                seed: opts.seed,
              }
            : {
                origin: opts.origin,
                destination: opts.destination,
                slackMin: opts.slackMin,
                interests: opts.interests,
                weights: effectiveWeights(prefs),
              },
        ),
      });
      const body = await res.json();
      if (id !== requestId.current) return;
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);

      /**
       * Shuffled before display, per §10 — and this has to be right *before*
       * any choices are logged, not retrofitted. Present three walks in a
       * fixed order and the model learns that people like the top of a list,
       * which is true, useless, and afterwards indistinguishable from a real
       * preference.
       *
       * The engine's own ordering is meaningful (fastest first for A-to-B,
       * most scenic first for loops), so it's preserved in `rank` for the
       * card labels — only the *screen position* is randomised.
       */
      const raw: Walk[] = (isLoop ? body.loops : body.routes) as Walk[];
      const walks = shuffled(raw.map((w, rank) => ({ ...w, rank })));
      setResult({ query: body.query, walks });
      setSelected(0);
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
      center: [-73.99, 40.72],
      zoom: 12.5,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __map?: MapLibreMap }).__map = map;
    }

    map.on("error", (e) => {
      const message = e.error?.message ?? String(e);
      console.error("[maplibre]", message);
      setMapError(message);
    });
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

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
        filter: ["!", ["get", "active"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.35 },
      });
      // The chosen loop draws in its own layer above the others, so it can't be
      // hidden underneath one it happens to share a street with.
      map.addLayer({
        id: LAYER_ACTIVE,
        type: "line",
        source: SOURCE,
        filter: ["get", "active"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 6, "line-opacity": 1 },
      });
      setReady(true);
    };
    if (map.isStyleLoaded()) addLayers();
    else map.on("styledata", addLayers);

    // MapLibre sizes its canvas once and never re-checks, so any change to the
    // container leaves a stale canvas with dead space around it — switching
    // between the stacked and side-by-side layouts, or rotating a phone, both
    // do it. The window `resize` event isn't enough: the container can change
    // size while the window doesn't.
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Tap the map to set where the walk starts.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: { lngLat: { lng: number; lat: number } }) => {
      const pt = { lon: e.lngLat.lng, lat: e.lngLat.lat };
      setSeed(0);

      if (mode === "loop") {
        setOrigin(pt);
        void findWalks({ mode, origin: pt, durationMin: duration, slackMin, interests, seed: 0 });
        return;
      }

      // A-to-B: first tap is where you are, second is where you're going, a
      // third starts over.
      if (!origin || destination) {
        setOrigin(pt);
        setDestination(null);
        setResult(null);
      } else {
        setDestination(pt);
        void findWalks({ mode, origin, destination: pt, durationMin: duration, slackMin, interests, seed: 0 });
      }
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [ready, mode, duration, slackMin, interests, origin, destination]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    for (const [pt, color] of [
      [origin, "#0f172a"],
      [mode === "ab" ? destination : null, "#dc2626"],
    ] as const) {
      if (!pt) continue;
      markersRef.current.push(
        new Marker({ color }).setLngLat([pt.lon, pt.lat]).addTo(map),
      );
    }
  }, [ready, origin, destination, mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(SOURCE);
    if (!source || !("setData" in source)) return;

    (source as { setData: (d: unknown) => void }).setData({
      type: "FeatureCollection",
      features: (result?.walks ?? []).map((loop, i) => ({
        type: "Feature" as const,
        properties: { color: LOOP_COLORS[i] ?? "#059669", active: i === selected },
        geometry: loop.geometry,
      })),
    });

    const loop = result?.walks[selected];
    if (loop && loop.geometry.coordinates.length > 1) {
      let w = 180, e = -180, s = 90, n = -90;
      for (const [lon, lat] of loop.geometry.coordinates) {
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
      // A degenerate box — start and destination on the same node — makes
      // fitBounds zoom out to the whole planet, which is a startling way to
      // respond to a double tap. Guarded rather than clamped, because the
      // useful reaction is to leave the view alone.
      if (e > w || n > s) {
        map.fitBounds([[w, s], [e, n]], { padding: 60, duration: 600, maxZoom: 15 });
      }
    }
  }, [ready, result, selected]);

  function ask(mins: number) {
    setDuration(mins);
    setSeed(0);
    if (origin) {
      void findWalks({ mode, origin, destination, durationMin: mins, slackMin, interests, seed: 0 });
    }
  }

  function changeSlack(value: number) {
    setSlackMin(value);
    if (origin && destination) {
      void findWalks({ mode, origin, destination, durationMin: duration, slackMin: value, interests, seed: 0 });
    }
  }

  function switchMode(next: "loop" | "ab") {
    setMode(next);
    setDestination(null);
    setResult(null);
    setSeed(0);
    // A loop needs only a start, so it can run immediately; A-to-B waits for
    // a destination.
    if (next === "loop" && origin) {
      void findWalks({ mode: next, origin, durationMin: duration, slackMin, interests, seed: 0 });
    }
  }

  /**
   * A pick is a data point: which of the three shown was chosen, and where it
   * sat on screen. §10 needs both — the features to learn from, and the
   * position to detect the bias that would otherwise masquerade as taste.
   */
  function noteChoice(index: number) {
    const walks = result?.walks;
    if (!walks || walks.length < 2) return;
    recordChoice({
      at: new Date().toISOString(),
      shown: walks.map((w) => featureVector(w.axes)),
      chosenIndex: index,
    });
  }

  function keep(loop: Walk) {
    const walk: SavedWalk = {
      id: `${Date.now()}-${loop.id}`,
      name: `${Math.round(loop.time / 60)} min from here`,
      savedAt: new Date().toISOString(),
      kind: mode,
      timeSeconds: loop.time,
      metres: loop.len,
      reasons: reasons(loop),
      geometry: loop.geometry,
    };
    saveWalk(walk);
    noteChoice(selected);
  }

  /** A saved walk is no use trapped in a tab — hand it over as GPX. */
  function download(walk: SavedWalk) {
    const blob = new Blob([walkToGpx(walk)], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${walk.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function regenerate() {
    if (!origin) return;
    const next = seed + 1;
    setSeed(next);
    void findWalks({ mode, origin, destination, durationMin: duration, slackMin, interests, seed: next });
  }

  return (
    <div className="flex h-dvh w-full flex-col font-sans text-slate-900 md:flex-row-reverse">
      {/*
        On a phone the panel and the map share one column, and `flex-1` alone
        lets the map collapse to nothing as soon as three loop cards exist —
        on the device this is mostly used on. So the map keeps a floor and the
        panel scrolls within what's left; on a wide screen they sit side by
        side and neither needs a cap.
      */}
      <div className="relative min-h-[45vh] flex-1 md:min-h-0">
        <div ref={containerRef} className="h-full w-full" />
        {mapError && (
          <div className="absolute inset-x-3 top-3 rounded-lg border border-red-200 bg-red-50/95 px-3 py-2 text-xs text-red-800">
            {mapError}
          </div>
        )}
      </div>

      <aside className="flex max-h-[55vh] w-full shrink-0 flex-col overflow-y-auto border-slate-200 bg-white p-4 md:max-h-none md:w-96 md:border-r">
        <h1 className="text-xl font-semibold tracking-tight">
          {mode === "loop" ? "A nice walk from here" : "A nicer way there"}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {mode === "loop"
            ? origin
              ? "Tap anywhere to start somewhere else."
              : "Tap the map to say where you're starting."
            : !origin
              ? "Tap where you're starting."
              : !destination
                ? "Now tap where you're going."
                : "Tap again to start over."}
        </p>

        {/*
          Two genuinely different questions, so they get a real switch rather
          than a hidden mode. §3: loop mode is the wedge — the request no other
          app can express — and A-to-B is the retention layer, so loop leads.
        */}
        <div className="mt-3 flex rounded-lg border border-slate-200 p-0.5">
          {(["loop", "ab"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === m ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {m === "loop" ? "Round trip" : "Get me there"}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {mode === "ab" ? (
            <label className="block text-sm text-slate-600">
              I&apos;ll spend up to{" "}
              <span className="font-semibold text-slate-900">+{slackMin} min</span>{" "}
              more than the quickest way
              <input
                type="range"
                min={0}
                max={45}
                step={1}
                value={slackMin}
                onChange={(e) => changeSlack(Number(e.target.value))}
                className="mt-1.5 w-full accent-slate-900"
              />
            </label>
          ) : (
          <div className="flex gap-1.5">
            {DURATIONS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => ask(m)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  duration === m
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 text-slate-700 hover:border-slate-400"
                }`}
              >
                {m} min
              </button>
            ))}
          </div>
          )}
        </div>

        {/*
          Preferences are set in onboarding and summarised here rather than
          re-edited inline. The counts still show, because §6 wants the proof
          that we listened to stay visible — not just appear once at signup.
        */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
          {interests.map((phrase) => {
            const report = result?.query.interests.find((r) => r.phrase === phrase);
            const good =
              report?.status === "resolved" && report.coverage !== "not-extracted";
            return (
              <span
                key={phrase}
                className={`rounded-full border px-2 py-0.5 ${
                  // Neutral until a route comes back: amber before we've asked
                  // reads as "we can't map that", which is a different and
                  // much worse claim than "we don't know yet".
                  !report
                    ? "border-slate-200 text-slate-600"
                    : good
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-amber-200 bg-amber-50 text-amber-800"
                }`}
              >
                {report?.label ?? phrase}
                {good && report?.matchCount ? ` ✓ ${fmt.format(report.matchCount)}` : ""}
                {report?.status === "unresolved" ? " — can't map that" : ""}
                {report?.coverage === "not-extracted" ? " — no data yet" : ""}
              </span>
            );
          })}
          <button
            type="button"
            onClick={onEditPrefs}
            className="rounded-full border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-50"
          >
            {interests.length ? "edit" : "what I like"}
          </button>
          {saved.length > 0 && (
            <button
              type="button"
              onClick={() => setShowSaved((v) => !v)}
              className="rounded-full border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-50"
            >
              saved ({saved.length})
            </button>
          )}
        </div>

        {showSaved && (
          <ul className="mt-2 space-y-1.5">
            {saved.map((walk) => (
              <li
                key={walk.id}
                className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{walk.name}</span>{" "}
                  <span className="text-slate-500">{km(walk.metres)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => download(walk)}
                  className="shrink-0 text-xs text-slate-600 underline underline-offset-2"
                >
                  GPX
                </button>
                <button
                  type="button"
                  onClick={() => deleteWalk(walk.id)}
                  aria-label={`Delete ${walk.name}`}
                  className="shrink-0 text-slate-400 hover:text-slate-900"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {pending && <p className="mt-4 text-sm text-slate-500">Finding walks…</p>}
        {error && (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-900">
            {error}
          </p>
        )}

        {result && !pending && result.walks.every((w) => w.len === 0) && (
          <p className="mt-4 rounded-lg border border-slate-200 p-3 text-sm text-slate-600">
            That&apos;s where you already are. Tap somewhere else to walk to.
          </p>
        )}

        {result && !pending && result.walks.some((w) => w.len > 0) && (
          <>
            <ul className="mt-4 space-y-2">
              {result.walks.filter((w) => w.len > 0).map((loop, i) => (
                <li key={loop.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(i)}
                    className={`w-full rounded-xl border p-3 text-left transition ${
                      i === selected
                        ? "border-slate-900 shadow-sm"
                        : "border-slate-200 hover:border-slate-400"
                    }`}
                  >
                    <div className="flex items-baseline gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: LOOP_COLORS[i] }}
                      />
                      <span className="text-lg font-semibold">
                        {Math.round(loop.time / 60)} min
                      </span>
                      <span className="text-sm text-slate-500">{km(loop.len)}</span>
                      {/* Honest when the geography couldn't answer the question. */}
                      {mode === "loop" && loop.onTarget === false && (
                        <span className="ml-auto text-xs text-amber-700">
                          longest that fits here
                        </span>
                      )}
                      {mode === "ab" && (
                        <span className="ml-auto text-xs text-slate-500">
                          {loop.detour && loop.detour > 30
                            ? `+${Math.round(loop.detour / 60)} min`
                            : "quickest"}
                        </span>
                      )}
                    </div>
                    <ul className="mt-1.5 space-y-0.5">
                      {reasons(loop).map((r) => (
                        <li key={r} className="text-sm text-slate-700">
                          · {r}
                        </li>
                      ))}
                    </ul>
                  </button>
                </li>
              ))}
            </ul>

            <div className="mt-3 flex gap-2">
              {mode === "loop" && (
                <button
                  type="button"
                  onClick={regenerate}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  Show me something else
                </button>
              )}
              <button
                type="button"
                onClick={() => result.walks[selected] && keep(result.walks[selected])}
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                Save this one
              </button>
            </div>
          </>
        )}

        <p className="mt-auto pt-4 text-[11px] text-slate-400">
          Walking routes from OpenStreetMap ·{" "}
          <a className="underline" href="https://www.openstreetmap.org/copyright">
            © OpenStreetMap contributors
          </a>
        </p>
      </aside>
    </div>
  );
}
