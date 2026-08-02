import type { Metadata } from "next";
import { tryLoadGraph } from "@/lib/graph-server";
import { scoresFor } from "@/lib/scores-server";
import GraphMap from "./graph-map";

export const metadata: Metadata = {
  title: "Scenic score · Scenic Route debug",
};

/**
 * Both artifacts are rebuilt out-of-band by the pipeline scripts, so this page
 * must never be prerendered against whatever happened to be on disk at build
 * time.
 */
export const dynamic = "force-dynamic";

export default function GraphDebugPage() {
  const loaded = tryLoadGraph();

  if (!loaded) {
    return (
      <Missing title="No graph artifact">
        <code className="font-mono">data/graph.json</code> is gitignored and
        rebuildable. Build it, then reload:
        <Commands>npm run fetch:osm{"\n"}npm run build:graph</Commands>
        The fetch is slow and cached per tile; the build takes seconds.
      </Missing>
    );
  }

  const status = scoresFor(loaded);

  return (
    <GraphMap
      meta={loaded.graph.meta}
      summary={loaded.summary}
      scoreMeta={status.state === "ok" ? status.scores.meta : null}
      scoreProblem={
        status.state === "stale"
          ? `Scores were computed against a graph built ${new Date(
              status.scoredAgainst,
            ).toLocaleString()}, but the graph on disk was built ${new Date(
              status.graphBuiltAt,
            ).toLocaleString()}. Re-run \`npm run score:graph\`.`
          : status.state === "missing"
            ? "No scores yet — run `npm run fetch:features && npm run score:graph`."
            : null
      }
    />
  );
}

function Missing({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-xl p-8 font-sans text-slate-900">
      <h1 className="text-lg font-semibold">{title}</h1>
      <div className="mt-2 text-sm text-slate-600">{children}</div>
    </main>
  );
}

function Commands({ children }: { children: React.ReactNode }) {
  return (
    <pre className="my-3 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100">
      {children}
    </pre>
  );
}
