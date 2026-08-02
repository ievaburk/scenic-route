/**
 * The router: bidirectional A* over `cost(e) = time(e) · (1 − α · scenic(e))`.
 *
 * This is the part PLAN.md §7 says to own rather than buy. Hosted routing APIs
 * can't accept an arbitrary per-edge weight, and that weight is the entire
 * product — so the search is ours.
 *
 * Nothing here touches the filesystem or the score artifact; it takes a
 * `RoutingGraph` plus a per-edge `scenic` array and searches. Building those
 * lives in `lib/router-server.ts`.
 */
import type { GraphArtifact } from "./graph";
import { projector } from "./geo";
import { WALK_SPEED_MPS } from "./pilot";

/**
 * Adjacency in compressed-sparse-row form: for node `n`, its incident edges are
 * `adjEdge[offsets[n] .. offsets[n+1]]` and the node across each is the matching
 * entry in `adjNode`.
 *
 * Three flat typed arrays rather than an array of arrays because the inner loop
 * of A* walks these for every settled node, and 116k small arrays is both a lot
 * of pointer chasing and a lot of GC pressure for something re-run eight times
 * per request.
 *
 * The walking graph is undirected — every edge appears in both endpoints' lists.
 */
export type RoutingGraph = {
  nodeCount: number;
  edgeCount: number;
  offsets: Int32Array;
  adjEdge: Int32Array;
  adjNode: Int32Array;
  /** Seconds on foot, per edge. */
  time: Float32Array;
  /** Metres, per edge. */
  len: Float32Array;
  /** Node positions projected to metres, for the Euclidean heuristic. */
  x: Float64Array;
  y: Float64Array;
};

export function buildRoutingGraph(graph: GraphArtifact): RoutingGraph {
  const nodeCount = graph.nodes.lon.length;
  const edgeCount = graph.edges.length;

  const degree = new Int32Array(nodeCount);
  for (const e of graph.edges) {
    degree[e.a]++;
    degree[e.b]++;
  }

  const offsets = new Int32Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n++) offsets[n + 1] = offsets[n] + degree[n];

  const adjEdge = new Int32Array(offsets[nodeCount]);
  const adjNode = new Int32Array(offsets[nodeCount]);
  const cursor = offsets.slice(0, nodeCount);

  const time = new Float32Array(edgeCount);
  const len = new Float32Array(edgeCount);

  for (let i = 0; i < edgeCount; i++) {
    const e = graph.edges[i];
    time[i] = e.time;
    len[i] = e.len;

    adjEdge[cursor[e.a]] = i;
    adjNode[cursor[e.a]] = e.b;
    cursor[e.a]++;

    adjEdge[cursor[e.b]] = i;
    adjNode[cursor[e.b]] = e.a;
    cursor[e.b]++;
  }

  const proj = projector(graph.nodes.lon[0], graph.nodes.lat[0]);
  const x = new Float64Array(nodeCount);
  const y = new Float64Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) {
    x[n] = proj.x(graph.nodes.lon[n]);
    y[n] = proj.y(graph.nodes.lat[n]);
  }

  return { nodeCount, edgeCount, offsets, adjEdge, adjNode, time, len, x, y };
}

// ---------------------------------------------------------------------------
// Priority queue
// ---------------------------------------------------------------------------

/**
 * Binary heap over parallel typed arrays.
 *
 * Lazy deletion — a node can be pushed several times and stale entries are
 * skipped on pop by comparing against the current best distance. Cheaper than
 * maintaining a decrease-key index for graphs this size.
 */
class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  clear() {
    this.size = 0;
  }

  push(key: number, val: number) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      const vals = new Int32Array(this.size * 2);
      keys.set(this.keys);
      vals.set(this.vals);
      this.keys = keys;
      this.vals = vals;
    }

    let i = this.size++;
    this.keys[i] = key;
    this.vals[i] = val;

    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  /** Returns the value with the smallest key, or -1 when empty. */
  pop(): number {
    if (this.size === 0) return -1;
    const top = this.vals[0];
    this.size--;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size];
      this.vals[0] = this.vals[this.size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.size && this.keys[l] < this.keys[smallest]) smallest = l;
        if (r < this.size && this.keys[r] < this.keys[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  peekKey(): number {
    return this.size === 0 ? Infinity : this.keys[0];
  }

  private swap(a: number, b: number) {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const v = this.vals[a];
    this.vals[a] = this.vals[b];
    this.vals[b] = v;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type Route = {
  /** Edge indices in traversal order. */
  edges: number[];
  /** Node indices, one longer than `edges`. */
  nodes: number[];
  /** Seconds on foot — real walking time, not discounted cost. */
  time: number;
  /** Metres. */
  len: number;
  /** Length-weighted mean scenic score over the route, 0–1. */
  scenic: number;
};

/**
 * Scratch buffers, allocated once and reused across the ~24 searches a single
 * request makes (8 for the α sweep × 3 alternates). Reallocating six 116k-entry
 * arrays per search would dominate the runtime we're trying to keep under
 * 100 ms.
 */
export type SearchScratch = {
  gf: Float64Array;
  gb: Float64Array;
  parentEdgeF: Int32Array;
  parentEdgeB: Int32Array;
  parentNodeF: Int32Array;
  parentNodeB: Int32Array;
  closedF: Uint8Array;
  closedB: Uint8Array;
  /** Lazily-filled balanced potential per node — see `findRoute`. */
  pot: Float64Array;
  heapF: MinHeap;
  heapB: MinHeap;
};

export function makeScratch(g: RoutingGraph): SearchScratch {
  return {
    gf: new Float64Array(g.nodeCount),
    gb: new Float64Array(g.nodeCount),
    parentEdgeF: new Int32Array(g.nodeCount),
    parentEdgeB: new Int32Array(g.nodeCount),
    parentNodeF: new Int32Array(g.nodeCount),
    parentNodeB: new Int32Array(g.nodeCount),
    closedF: new Uint8Array(g.nodeCount),
    closedB: new Uint8Array(g.nodeCount),
    pot: new Float64Array(g.nodeCount),
    heapF: new MinHeap(4096),
    heapB: new MinHeap(4096),
  };
}

export type SearchOptions = {
  /** Per-edge scenic score in [0,1] — the weighted blend of the axes. */
  scenic: Float32Array;
  /** Scenery greed. 0 is the fastest route; must stay below 1 so costs stay positive. */
  alpha: number;
  /**
   * Optional per-edge cost multiplier, ≥ 1. This is how alternates are found:
   * inflate a returned route's edges and search again (PLAN.md §8).
   */
  penalty?: Float32Array;
};

/**
 * Bidirectional A*.
 *
 * The heuristic is straight-line distance at the fastest walking speed, scaled
 * by (1 − α). That stays admissible because no edge can cost less than its
 * length at full speed with the largest possible discount — `scenic` is capped
 * at 1 and penalties only ever increase cost.
 *
 * The two frontiers use **balanced potentials**, `p_f = (h_f − h_b) / 2` and
 * `p_b = −p_f`, rather than each simply using its own heuristic. This is the
 * detail that makes bidirectional A* actually correct rather than
 * approximately correct: because the two potentials sum to zero, the plain
 * bidirectional stopping rule `topF + topB ≥ μ` is exact. With each side using
 * its own raw heuristic the potentials don't cancel, the rule no longer bounds
 * what's left unexplored, and the search can return a path that merely looks
 * plausible. Both potentials stay consistent, so reduced costs stay
 * non-negative and Dijkstra's argument still holds.
 *
 * Returns null when no path exists — possible in principle, though the graph
 * build keeps only the largest connected component.
 */
export function findRoute(
  g: RoutingGraph,
  scratch: SearchScratch,
  source: number,
  target: number,
  opts: SearchOptions,
): Route | null {
  const { scenic, alpha, penalty } = opts;
  const {
    gf, gb, parentEdgeF, parentEdgeB, parentNodeF, parentNodeB,
    closedF, closedB, pot, heapF, heapB,
  } = scratch;

  if (source === target) {
    return { edges: [], nodes: [source], time: 0, len: 0, scenic: 0 };
  }

  gf.fill(Infinity);
  gb.fill(Infinity);
  closedF.fill(0);
  closedB.fill(0);
  parentEdgeF.fill(-1);
  parentEdgeB.fill(-1);
  parentNodeF.fill(-1);
  parentNodeB.fill(-1);
  // NaN marks "not yet computed" for the lazy potential cache below.
  pot.fill(NaN);
  heapF.clear();
  heapB.clear();

  const speed = WALK_SPEED_MPS;
  const discount = 1 - alpha;
  const tx = g.x[target];
  const ty = g.y[target];
  const sx = g.x[source];
  const sy = g.y[source];
  /** Distance → cost, folded once instead of per call. */
  const scale = discount / speed / 2;

  /**
   * Balanced potential `(h_f − h_b) / 2`, cached per node.
   *
   * It depends only on the node and the two endpoints, but it's read on every
   * edge relaxation — several times per node. Computing it eagerly for all
   * 116k nodes would cost more than the search; recomputing it per relaxation
   * made A* no faster than plain Dijkstra, because two `hypot` calls per
   * relaxation cancelled out everything the better ordering saved.
   */
  const pf = (n: number) => {
    const cached = pot[n];
    // Self-comparison is the fast NaN test.
    if (cached === cached) return cached;
    const p =
      (Math.hypot(g.x[n] - tx, g.y[n] - ty) -
        Math.hypot(g.x[n] - sx, g.y[n] - sy)) *
      scale;
    pot[n] = p;
    return p;
  };

  gf[source] = 0;
  gb[target] = 0;
  heapF.push(pf(source), source);
  heapB.push(-pf(target), target);

  /** Best complete path cost found so far, and where the two sides met. */
  let mu = Infinity;
  let meet = -1;

  const cost = (e: number) =>
    g.time[e] * (1 - alpha * scenic[e]) * (penalty ? penalty[e] : 1);

  while (heapF.size > 0 && heapB.size > 0) {
    // The exactness of this test is the whole reason for balanced potentials.
    if (heapF.peekKey() + heapB.peekKey() >= mu) break;

    // Expand whichever frontier is currently cheaper, which keeps the two
    // searches meeting near the middle.
    if (heapF.peekKey() <= heapB.peekKey()) {
      const n = heapF.pop();
      if (n < 0) break;
      if (closedF[n]) continue;
      closedF[n] = 1;

      for (let i = g.offsets[n]; i < g.offsets[n + 1]; i++) {
        const e = g.adjEdge[i];
        const m = g.adjNode[i];
        const nd = gf[n] + cost(e);
        if (nd < gf[m]) {
          gf[m] = nd;
          parentEdgeF[m] = e;
          parentNodeF[m] = n;
          heapF.push(nd + pf(m), m);
          if (gb[m] < Infinity && nd + gb[m] < mu) {
            mu = nd + gb[m];
            meet = m;
          }
        }
      }
    } else {
      const n = heapB.pop();
      if (n < 0) break;
      if (closedB[n]) continue;
      closedB[n] = 1;

      for (let i = g.offsets[n]; i < g.offsets[n + 1]; i++) {
        const e = g.adjEdge[i];
        const m = g.adjNode[i];
        const nd = gb[n] + cost(e);
        if (nd < gb[m]) {
          gb[m] = nd;
          parentEdgeB[m] = e;
          parentNodeB[m] = n;
          heapB.push(nd - pf(m), m);
          if (gf[m] < Infinity && gf[m] + nd < mu) {
            mu = gf[m] + nd;
            meet = m;
          }
        }
      }
    }
  }

  if (meet < 0) return null;

  // Walk out to the source, then to the target, and join at the meeting node.
  const nodes: number[] = [];
  const edges: number[] = [];

  for (let n = meet; n !== -1; n = parentNodeF[n]) {
    nodes.push(n);
    if (parentEdgeF[n] !== -1) edges.push(parentEdgeF[n]);
  }
  nodes.reverse();
  edges.reverse();

  for (let n = meet; parentNodeB[n] !== -1; n = parentNodeB[n]) {
    edges.push(parentEdgeB[n]);
    nodes.push(parentNodeB[n]);
  }

  return summarise(g, scenic, nodes, edges);
}

/** Real walking time, length and length-weighted scenic value for a path. */
export function summarise(
  g: RoutingGraph,
  scenic: Float32Array,
  nodes: number[],
  edges: number[],
): Route {
  let time = 0;
  let len = 0;
  let scenicMetres = 0;

  for (const e of edges) {
    time += g.time[e];
    len += g.len[e];
    // Length-weighted, per PLAN.md §8: scenic value accrues per metre walked,
    // so a 2 km stretch along the water counts far more than a 50 m one.
    scenicMetres += scenic[e] * g.len[e];
  }

  return {
    edges,
    nodes,
    time,
    len,
    scenic: len > 0 ? scenicMetres / len : 0,
  };
}

/**
 * Plain unidirectional Dijkstra over the same cost function.
 *
 * Exists to check the bidirectional search against, not to serve traffic — see
 * `scripts/check-routes.ts`. A subtly wrong bidirectional implementation
 * returns paths that look entirely reasonable on a map, so "looks fine" is not
 * evidence; the only way to know is to compare against something obviously
 * correct.
 */
export function findRouteDijkstra(
  g: RoutingGraph,
  source: number,
  target: number,
  opts: SearchOptions,
): Route | null {
  const { scenic, alpha, penalty } = opts;
  const dist = new Float64Array(g.nodeCount).fill(Infinity);
  const parentEdge = new Int32Array(g.nodeCount).fill(-1);
  const parentNode = new Int32Array(g.nodeCount).fill(-1);
  const closed = new Uint8Array(g.nodeCount);
  const heap = new MinHeap(4096);

  dist[source] = 0;
  heap.push(0, source);

  while (heap.size > 0) {
    const n = heap.pop();
    if (n < 0 || closed[n]) continue;
    closed[n] = 1;
    if (n === target) break;

    for (let i = g.offsets[n]; i < g.offsets[n + 1]; i++) {
      const e = g.adjEdge[i];
      const m = g.adjNode[i];
      const nd =
        dist[n] +
        g.time[e] * (1 - alpha * scenic[e]) * (penalty ? penalty[e] : 1);
      if (nd < dist[m]) {
        dist[m] = nd;
        parentEdge[m] = e;
        parentNode[m] = n;
        heap.push(nd, m);
      }
    }
  }

  if (dist[target] === Infinity) return null;

  const nodes: number[] = [];
  const edges: number[] = [];
  for (let n = target; n !== -1; n = parentNode[n]) {
    nodes.push(n);
    if (parentEdge[n] !== -1) edges.push(parentEdge[n]);
  }
  nodes.reverse();
  edges.reverse();

  return summarise(g, scenic, nodes, edges);
}

/** Total cost of a route under a given α — what the search actually minimises. */
export function routeCost(
  g: RoutingGraph,
  route: Route,
  opts: SearchOptions,
): number {
  let total = 0;
  for (const e of route.edges) {
    total +=
      g.time[e] *
      (1 - opts.alpha * opts.scenic[e]) *
      (opts.penalty ? opts.penalty[e] : 1);
  }
  return total;
}
