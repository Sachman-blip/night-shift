// Pathfinding over a generated layout's nav graph. Gated edges are only
// traversable when the caller says their gate is open.

import type { NavNode, NavEdge, GateId } from "../../../shared/map";
import type { LosSystem } from "./los";

export type IsGateOpen = (gate: GateId) => boolean;

export interface NavSystem {
  nodes: Record<string, NavNode>;
  findPath(from: string, to: string, isOpen: IsGateOpen): string[];
  nearestVisibleNode(x: number, z: number): string;
  /** BFS reachability from a node; gates via isOpen. */
  reachable(from: string, isOpen: IsGateOpen): Set<string>;
  /** Shortest-path distance between nodes (all gates open); Infinity if none. */
  distance(from: string, to: string): number;
}

export function createNav(
  nodes: Record<string, NavNode>,
  edges: NavEdge[],
  los: LosSystem
): NavSystem {
  const ids = Object.keys(nodes);
  interface Adj { to: string; w: number; gate?: GateId }
  const adjacency = new Map<string, Adj[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const { a, b, gate } of edges) {
    const na = nodes[a];
    const nb = nodes[b];
    if (!na || !nb) throw new Error(`nav edge references unknown node ${a} or ${b}`);
    const w = Math.hypot(nb.x - na.x, nb.z - na.z);
    adjacency.get(a)!.push({ to: b, w, gate });
    adjacency.get(b)!.push({ to: a, w, gate });
  }

  function dijkstra(from: string, isOpen: IsGateOpen) {
    const dist = new Map<string, number>(ids.map((id) => [id, Infinity]));
    const prev = new Map<string, string>();
    const visited = new Set<string>();
    dist.set(from, 0);
    while (visited.size < ids.length) {
      let current: string | null = null;
      let best = Infinity;
      for (const id of ids) {
        const d = dist.get(id)!;
        if (!visited.has(id) && d < best) {
          best = d;
          current = id;
        }
      }
      if (current === null) break;
      visited.add(current);
      for (const { to, w, gate } of adjacency.get(current)!) {
        if (gate && !isOpen(gate)) continue;
        const nd = best + w;
        if (nd < dist.get(to)!) {
          dist.set(to, nd);
          prev.set(to, current);
        }
      }
    }
    return { dist, prev };
  }

  function findPath(from: string, to: string, isOpen: IsGateOpen): string[] {
    if (from === to) return [from];
    const { prev } = dijkstra(from, isOpen);
    if (!prev.has(to)) return [from];
    const path: string[] = [to];
    while (path[0] !== from) path.unshift(prev.get(path[0])!);
    return path;
  }

  function nearestVisibleNode(x: number, z: number): string {
    let bestVisible: string | null = null;
    let bestVisibleD = Infinity;
    let bestAny = ids[0];
    let bestAnyD = Infinity;
    for (const id of ids) {
      const n = nodes[id];
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bestAnyD) {
        bestAnyD = d;
        bestAny = id;
      }
      if (d < bestVisibleD && los.losClear(x, z, n.x, n.z)) {
        bestVisibleD = d;
        bestVisible = id;
      }
    }
    return bestVisible ?? bestAny;
  }

  function reachable(from: string, isOpen: IsGateOpen): Set<string> {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length) {
      const id = queue.pop()!;
      for (const { to, gate } of adjacency.get(id)!) {
        if (gate && !isOpen(gate)) continue;
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    return seen;
  }

  function distance(from: string, to: string): number {
    return dijkstra(from, () => true).dist.get(to) ?? Infinity;
  }

  return { nodes, findPath, nearestVisibleNode, reachable, distance };
}
