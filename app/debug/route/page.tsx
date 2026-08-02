import type { Metadata } from "next";
import { tryLoadGraph } from "@/lib/graph-server";
import { scoresFor } from "@/lib/scores-server";
import RouteMap from "./route-map";

export const metadata: Metadata = {
  title: "Router · Scenic Route debug",
};

export const dynamic = "force-dynamic";

export default function RouteDebugPage() {
  const loaded = tryLoadGraph();
  const status = loaded ? scoresFor(loaded) : null;

  if (!loaded || status?.state !== "ok") {
    return (
      <main className="mx-auto max-w-xl p-8 font-sans text-slate-900">
        <h1 className="text-lg font-semibold">Routing isn&apos;t ready</h1>
        <p className="mt-2 text-sm text-slate-600">
          The router needs the graph and a matching score artifact. Both are
          gitignored and rebuildable:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100">
          npm run fetch:osm{"\n"}npm run build:graph{"\n"}npm run
          fetch:features{"\n"}npm run score:graph
        </pre>
        {status?.state === "stale" && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            Scores exist but were computed against a different build of the
            graph, so every edge index would point at the wrong street. Re-run{" "}
            <code className="font-mono">npm run score:graph</code>.
          </p>
        )}
      </main>
    );
  }

  return <RouteMap edges={loaded.graph.meta.edges} />;
}
