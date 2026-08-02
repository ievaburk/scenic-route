/**
 * Server-side access to the scenic score artifact.
 *
 * Same singleton treatment as the graph (see `graph-server.ts`) and for the
 * same reason: it's parsed once and then read from on every request.
 *
 * The mismatch check is the part worth keeping. Scores are index-aligned with
 * `graph.edges` and nothing in the file format enforces that — rebuild the
 * graph without re-scoring and every lookup silently shifts to a different
 * street. That failure renders a perfectly plausible map, which is the worst
 * kind, so a stale artifact is refused rather than used.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ScoreArtifact } from "./scoring";
import type { LoadedGraph } from "./graph-server";

export const SCORES_FILE = path.join(process.cwd(), "data", "scores.json");

export type LoadedScores = {
  scores: ScoreArtifact;
  etag: string;
};

/** Why scores aren't available, when they aren't. Surfaced in the debug UI. */
export type ScoresStatus =
  | { state: "ok"; scores: ScoreArtifact }
  | { state: "missing" }
  | { state: "stale"; scoredAgainst: string; graphBuiltAt: string };

const store = globalThis as typeof globalThis & {
  __scenicScores?: LoadedScores;
};

export function tryLoadScores(): LoadedScores | null {
  if (store.__scenicScores) return store.__scenicScores;
  if (!existsSync(SCORES_FILE)) return null;

  const scores = JSON.parse(readFileSync(SCORES_FILE, "utf8")) as ScoreArtifact;
  const loaded: LoadedScores = {
    scores,
    etag: `W/"${scores.meta.builtAt}-${scores.meta.edges}"`,
  };
  store.__scenicScores = loaded;
  return loaded;
}

/**
 * Scores for this exact graph, or a reason there aren't any.
 *
 * `builtAt` equality is the check, not edge count — two builds of the same
 * bbox can easily produce the same number of edges in a different order.
 */
export function scoresFor(graph: LoadedGraph): ScoresStatus {
  const loaded = tryLoadScores();
  if (!loaded) return { state: "missing" };

  const { meta } = loaded.scores;
  if (meta.graphBuiltAt !== graph.graph.meta.builtAt) {
    return {
      state: "stale",
      scoredAgainst: meta.graphBuiltAt,
      graphBuiltAt: graph.graph.meta.builtAt,
    };
  }

  return { state: "ok", scores: loaded.scores };
}
