/**
 * What the walker likes, and the walks they've kept.
 *
 * Local storage, deliberately. PLAN.md §11 assumes the prototype runs
 * single-user with no auth, and §4 keeps "accounts-required flows" out of the
 * MVP — asking someone to make an account before they can find out whether the
 * app suggests nice walks is exactly the wrong order.
 *
 * Everything goes through this module rather than touching `localStorage`
 * directly, so backing it with Supabase later (§7) is a change here and
 * nowhere else. That also means every read has to tolerate absent, corrupt or
 * outdated data: this runs in a browser whose storage the user can clear, and
 * a thrown exception on read would take the whole page down.
 */
import { AXIS_KEYS, DEFAULT_WEIGHTS, type ScenicAxis } from "./features";

const PREFS_KEY = "scenic-route.prefs.v1";
const SAVED_KEY = "scenic-route.saved.v1";

/** Bumping the key is how a breaking shape change gets handled — old data is simply ignored. */
export type Prefs = {
  weights: Record<ScenicAxis, number>;
  /** Raw phrases as typed. Resolution is the server's job and can improve later. */
  interests: string[];
  /** False until onboarding has been completed once. */
  onboarded: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  weights: { ...DEFAULT_WEIGHTS },
  interests: [],
  onboarded: false,
};

function read<T>(key: string, fallback: T, validate: (v: unknown) => T | null): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return validate(JSON.parse(raw)) ?? fallback;
  } catch {
    // Corrupt or unreadable — fall back rather than take the page down.
    return fallback;
  }
}

function write(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing, or the quota is full. Losing a preference is not worth
    // interrupting someone who is trying to go for a walk.
  }
}

export function loadPrefs(): Prefs {
  return read<Prefs>(PREFS_KEY, DEFAULT_PREFS, (v) => {
    if (!v || typeof v !== "object") return null;
    const o = v as Partial<Prefs>;

    // Rebuild the weight vector from the current axis list rather than trusting
    // what was stored: axes may have been added or renamed since it was written.
    const weights = { ...DEFAULT_WEIGHTS };
    for (const axis of AXIS_KEYS) {
      const w = (o.weights as Record<string, unknown> | undefined)?.[axis];
      if (typeof w === "number" && w >= 0 && w <= 1) weights[axis] = w;
    }

    return {
      weights,
      interests: Array.isArray(o.interests)
        ? o.interests.filter((s): s is string => typeof s === "string").slice(0, 5)
        : [],
      onboarded: o.onboarded === true,
    };
  });
}

/**
 * Local storage is an external store, so components subscribe to it rather than
 * copying it into state on mount.
 *
 * `useSyncExternalStore` is what React 19 wants here, and it needs a *stable*
 * snapshot — returning a freshly-parsed object each call would re-render
 * forever. Hence the cache, invalidated on write.
 *
 * The server snapshot is the defaults, which means a returning visitor renders
 * onboarding for one frame before hydration corrects it. `AppShell` avoids that
 * by holding its own "not known yet" state until mounted.
 */
let prefsCache: Prefs | null = null;
let savedCache: SavedWalk[] | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function prefsSnapshot(): Prefs {
  return (prefsCache ??= loadPrefs());
}

export function savedSnapshot(): SavedWalk[] {
  return (savedCache ??= loadSaved());
}

/**
 * The server snapshot, deliberately `null` rather than the defaults.
 *
 * React uses this during SSR and hydration, then switches to `prefsSnapshot`.
 * Returning the defaults would mean a returning visitor sees the onboarding
 * questionnaire for one frame before hydration corrects it; returning null
 * lets the shell render blank for that frame instead, and needs no extra state
 * or mount effect to do it.
 */
export function unknownPrefsSnapshot(): null {
  return null;
}

const NO_WALKS: SavedWalk[] = [];
export function noWalksSnapshot(): SavedWalk[] {
  return NO_WALKS;
}

export function savePrefs(prefs: Prefs) {
  write(PREFS_KEY, prefs);
  prefsCache = prefs;
  notify();
}

export type SavedWalk = {
  id: string;
  name: string;
  savedAt: string;
  kind: "loop" | "ab";
  timeSeconds: number;
  metres: number;
  /** Plain-language reasons, as shown on the card when it was saved. */
  reasons: string[];
  geometry: { type: "LineString"; coordinates: [number, number][] };
};

export function loadSaved(): SavedWalk[] {
  return read<SavedWalk[]>(SAVED_KEY, [], (v) => {
    if (!Array.isArray(v)) return null;
    return v.filter(
      (w): w is SavedWalk =>
        !!w &&
        typeof w.id === "string" &&
        typeof w.name === "string" &&
        !!w.geometry?.coordinates?.length,
    );
  });
}

export function saveWalk(walk: SavedWalk) {
  const next = [walk, ...loadSaved().filter((w) => w.id !== walk.id)].slice(0, 50);
  write(SAVED_KEY, next);
  savedCache = next;
  notify();
}

export function deleteWalk(id: string) {
  const next = loadSaved().filter((w) => w.id !== id);
  write(SAVED_KEY, next);
  savedCache = next;
  notify();
}

/**
 * A saved walk as GPX, so it's usable on a phone rather than trapped in a tab.
 *
 * §4 keeps offline out of the MVP, but a walk you can't take with you isn't
 * much of a saved walk — and this costs nothing beyond a string.
 */
export function walkToGpx(walk: SavedWalk): string {
  const escape = (s: string) =>
    s.replace(/[<>&'"]/g, (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

  const pts = walk.geometry.coordinates
    .map(([lon, lat]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="scenic-route" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escape(walk.name)}</name>
    <desc>Data © OpenStreetMap contributors (ODbL).</desc></metadata>
  <trk><name>${escape(walk.name)}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`;
}
