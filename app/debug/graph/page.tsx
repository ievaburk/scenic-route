import type { Metadata } from "next";
import { tryLoadGraph } from "@/lib/graph-server";
import GraphMap from "./graph-map";

export const metadata: Metadata = {
  title: "Walkable graph · Scenic Route debug",
};

/**
 * The graph artifact is rebuilt out-of-band by `npm run build:graph`, so this
 * page must never be prerendered against whatever happened to be on disk at
 * build time.
 */
export const dynamic = "force-dynamic";

export default function GraphDebugPage() {
  const loaded = tryLoadGraph();

  if (!loaded) {
    return (
      <main className="mx-auto max-w-xl p-8 font-sans text-slate-900">
        <h1 className="text-lg font-semibold">No graph artifact</h1>
        <p className="mt-2 text-sm text-slate-600">
          <code className="font-mono">data/graph.json</code> is gitignored and
          rebuildable. Build it, then reload:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100">
          npm run fetch:osm{"\n"}npm run build:graph
        </pre>
        <p className="mt-2 text-xs text-slate-500">
          The fetch is slow and cached per tile; the build takes seconds.
        </p>
      </main>
    );
  }

  return <GraphMap meta={loaded.graph.meta} summary={loaded.summary} />;
}
