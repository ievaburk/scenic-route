import type { Metadata } from "next";
import { tryLoadGraph } from "@/lib/graph-server";
import { scoresFor } from "@/lib/scores-server";
import AppShell from "./app-shell";

export const metadata: Metadata = {
  title: "Scenic Route — a nice walk from here",
  description:
    "Walking routes chosen for how interesting they are rather than how fast.",
};

/** Both artifacts are rebuilt out-of-band, so never prerender against them. */
export const dynamic = "force-dynamic";

export default function Home() {
  const loaded = tryLoadGraph();
  const status = loaded ? scoresFor(loaded) : null;

  if (!loaded || status?.state !== "ok") {
    return (
      <main className="mx-auto max-w-xl p-8 font-sans text-slate-900">
        <h1 className="text-lg font-semibold">Not built yet</h1>
        <p className="mt-2 text-sm text-slate-600">
          The walking graph and its scores are gitignored and rebuildable:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100">
          npm run fetch:osm{"\n"}npm run build:graph{"\n"}npm run fetch:features{"\n"}npm run score:graph
        </pre>
      </main>
    );
  }

  return <AppShell />;
}
