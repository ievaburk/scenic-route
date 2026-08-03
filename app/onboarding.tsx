"use client";

/**
 * Onboarding (PLAN.md §6): six chips, then one text field.
 *
 * The whole design rests on one thing — **the count comes back before any route
 * is requested**. "Bridges ✓ 1,046 nearby" is what proves the app listened,
 * and §6 says it should be impossible to miss. A text box that silently accepts
 * anything is worse than no text box, because it promises more than OSM can
 * deliver and the user only finds out much later, if ever.
 *
 * So the three outcomes stay visually distinct and are never collapsed:
 * a real count, "we haven't got that data" and "not something the map knows
 * about". §6 is explicit that getting this tone right is a product problem, and
 * that handling it badly makes the feature read as broken rather than limited.
 */
import { useEffect, useRef, useState } from "react";
import { SCENIC_AXES, type ScenicAxis } from "@/lib/features";
import { DEFAULT_PREFS, savePrefs, type Prefs } from "@/lib/prefs";

/** §6: rotating examples, so the field suggests what it can actually answer. */
const EXAMPLES = [
  "bridges",
  "cobblestone streets",
  "statues",
  "tunnels",
  "stairs",
  "fountains",
  "viewpoints",
];

type Resolution = {
  phrase: string;
  status: "resolved" | "unresolved" | "invalid";
  label?: string;
  matchCount?: number;
  coverage?: "ok" | "thin" | "not-extracted";
  message?: string;
};

const fmt = new Intl.NumberFormat("en-US");

export default function Onboarding({
  initial,
  onDone,
}: {
  initial: Prefs;
  onDone: (prefs: Prefs) => void;
}) {
  const [weights, setWeights] = useState(initial.weights);
  const [interests, setInterests] = useState<string[]>(initial.interests);
  const [draft, setDraft] = useState("");
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [checking, setChecking] = useState(false);
  const [exampleIndex, setExampleIndex] = useState(0);
  const inFlight = useRef(0);

  // Rotate the placeholder so the field reads as an invitation rather than a
  // search box that wants one right answer.
  useEffect(() => {
    const t = setInterval(() => setExampleIndex((i) => (i + 1) % EXAMPLES.length), 2600);
    return () => clearInterval(t);
  }, []);

  async function resolve(phrases: string[]) {
    if (phrases.length === 0) return;
    const id = ++inFlight.current;
    setChecking(true);
    try {
      const res = await fetch("/api/interests/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrases }),
      });
      const body = await res.json();
      if (id !== inFlight.current || !res.ok) return;
      const next: Record<string, Resolution> = {};
      for (const r of body.interests as Resolution[]) next[r.phrase] = r;
      setResolutions((prev) => ({ ...prev, ...next }));
    } catch {
      // Leaving the chip unannotated is better than blocking onboarding on a
      // failed lookup — the phrase is still saved and resolves at route time.
    } finally {
      if (id === inFlight.current) setChecking(false);
    }
  }

  useEffect(() => {
    // Deferred rather than called straight from the effect body: `resolve` sets
    // state synchronously before its first await, which React 19 flags as a
    // cascading render. Nothing here needs to block the first paint anyway.
    const t = setTimeout(() => {
      if (interests.length > 0) void resolve(interests);
    }, 0);
    return () => clearTimeout(t);
    // Only on mount: restoring someone's saved interests should show their counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleAxis(axis: ScenicAxis) {
    setWeights((w) => ({ ...w, [axis]: w[axis] > 0 ? 0 : 1 }));
  }

  function addInterest() {
    const phrase = draft.trim();
    if (!phrase || interests.length >= 5 || interests.includes(phrase)) return;
    setInterests([...interests, phrase]);
    setDraft("");
    void resolve([phrase]);
  }

  function finish() {
    const prefs: Prefs = { weights, interests, onboarded: true };
    savePrefs(prefs);
    onDone(prefs);
  }

  const anyAxis = Object.values(weights).some((w) => w > 0);

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center p-6 font-sans text-slate-900">
      <h1 className="text-2xl font-semibold tracking-tight">
        What makes a walk good?
      </h1>
      <p className="mt-1.5 text-slate-600">
        Pick whatever sounds right. You can change it later.
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        {SCENIC_AXES.map((axis) => {
          const on = weights[axis.key] > 0;
          return (
            <button
              key={axis.key}
              type="button"
              onClick={() => toggleAxis(axis.key)}
              aria-pressed={on}
              className={`rounded-full border px-3.5 py-1.5 text-sm transition ${
                on
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 text-slate-700 hover:border-slate-400"
              }`}
            >
              <span
                className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                style={{ backgroundColor: on ? "#fff" : axis.color }}
              />
              {axis.label}
            </button>
          );
        })}
      </div>
      {!anyAxis && (
        <p className="mt-2 text-sm text-amber-700">
          With nothing picked, you&apos;ll just get the quickest way round.
        </p>
      )}

      <h2 className="mt-7 text-lg font-semibold">Anything else you&apos;re into?</h2>
      <p className="mt-1 text-sm text-slate-600">
        Type a thing you like and we&apos;ll tell you how much of it is near you.
      </p>

      <div className="mt-2.5 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addInterest()}
          placeholder={EXAMPLES[exampleIndex]}
          disabled={interests.length >= 5}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 disabled:bg-slate-50"
        />
        <button
          type="button"
          onClick={addInterest}
          disabled={!draft.trim() || interests.length >= 5}
          className="rounded-lg border border-slate-300 px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:text-slate-300"
        >
          Add
        </button>
      </div>

      <ul className="mt-2.5 space-y-1.5">
        {interests.map((phrase) => {
          const r = resolutions[phrase];
          const good = r?.status === "resolved" && r.coverage !== "not-extracted";
          return (
            <li
              key={phrase}
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                !r
                  ? "border-slate-200 text-slate-500"
                  : good
                    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                    : "border-amber-200 bg-amber-50 text-amber-900"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">{r?.label ?? phrase}</span>{" "}
                {!r && (checking ? "checking…" : "")}
                {good && (
                  <>
                    ✓ {fmt.format(r.matchCount ?? 0)} nearby
                    {r.coverage === "thin" && (
                      <span className="block text-xs opacity-80">
                        Not many — we&apos;ll route past them when it isn&apos;t a big
                        detour, but it won&apos;t shape your walks much.
                      </span>
                    )}
                  </>
                )}
                {r?.coverage === "not-extracted" && (
                  <span className="block text-xs opacity-80">
                    We haven&apos;t got that data for your area yet, so we honestly
                    don&apos;t know.
                  </span>
                )}
                {r?.status === "unresolved" && (
                  <span className="block text-xs opacity-80">
                    Not something the map knows about. Plenty of things people love
                    aren&apos;t in OpenStreetMap and never will be.
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setInterests(interests.filter((p) => p !== phrase))}
                aria-label={`Remove ${phrase}`}
                className="shrink-0 opacity-60 hover:opacity-100"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>

      {interests.length >= 5 && (
        <p className="mt-1.5 text-xs text-slate-500">
          Five is the limit — past that, each one stops making a difference.
        </p>
      )}

      <button
        type="button"
        onClick={finish}
        className="mt-8 w-full rounded-xl bg-slate-900 px-4 py-3 text-base font-medium text-white hover:bg-slate-800"
      >
        Find me a walk
      </button>
      <p className="mt-3 text-center text-xs text-slate-400">
        Saved on this device. No account, nothing sent anywhere.
      </p>
    </main>
  );
}
