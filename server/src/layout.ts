// Server-side layout assembly: pick a random LayoutDescriptor, expand it
// with the shared buildLayout(), and validate every gameplay constraint.
// Throws if no valid layout can be found (should never happen — the
// constraints are satisfiable by construction; this is the safety net).

import {
  buildLayout,
  KEYCARD_CARRIERS,
  LOOT_COUNT,
  type Layout,
  type LayoutDescriptor,
  type LootCandidate,
} from "../../shared/map";
import { createLos, type LosSystem } from "./ai/los";
import { createNav, type NavSystem } from "./ai/nav";

export interface GeneratedLayout {
  descriptor: LayoutDescriptor;
  layout: Layout;
  los: LosSystem;
  nav: NavSystem;
  lootPicks: LootCandidate[];
}

const MIN_SPAWN_EXTRACT_DIST = 40; // meters, along the nav graph
const MIN_LOOT_SPACING = 4.5;

function shuffled<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function randomDescriptor(): LayoutDescriptor {
  return {
    north: shuffled([0, 1, 2]) as [number, number, number],
    south: shuffled([0, 1]) as [number, number],
    east: shuffled([0, 1]) as [number, number],
    closets: shuffled([0, 1, 2]) as [number, number, number],
    flipped: Math.random() < 0.5,
    keycard: Math.floor(Math.random() * KEYCARD_CARRIERS.length),
  };
}

// Sight-aware: a point's "nearest node" must not be matched through a wall
// (e.g. the breaker sitting 1.7m from an archives shelf node next door).
const nearestNode = (nav: NavSystem, x: number, z: number) =>
  nav.nearestVisibleNode(x, z);

/** Throws with a specific reason if the layout violates any constraint. */
export function validateLayout(layout: Layout, los: LosSystem, nav: NavSystem) {
  // 1. every nav edge is a straight sight-clear walk (gated edges are
  //    checked with their door absent — doors aren't static geometry)
  for (const { a, b } of layout.navEdges) {
    const na = nav.nodes[a];
    const nb = nav.nodes[b];
    if (!los.losClear(na.x, na.z, nb.x, nb.z)) {
      throw new Error(`nav edge ${a} <-> ${b} passes through geometry`);
    }
  }

  // 2. patrol route: consecutive stops (incl. wrap) must be UNGATED edges
  const edgeGate = new Map<string, boolean>();
  for (const { a, b, gate } of layout.navEdges) {
    edgeGate.set(`${a}|${b}`, !!gate);
    edgeGate.set(`${b}|${a}`, !!gate);
  }
  const route = layout.patrolRoute;
  for (let i = 0; i < route.length; i++) {
    const a = route[i];
    const b = route[(i + 1) % route.length];
    const gated = edgeGate.get(`${a}|${b}`);
    if (gated === undefined) throw new Error(`patrol step ${a} -> ${b} is not an edge`);
    if (gated) throw new Error(`patrol step ${a} -> ${b} uses a gated edge`);
  }

  // 3. reachability
  const spawn = layout.spawnPoints[0];
  const spawnNode = nearestNode(nav, spawn.x, spawn.z);
  const closed = nav.reachable(spawnNode, () => false);
  const open = nav.reachable(spawnNode, () => true);
  for (const id of Object.keys(nav.nodes)) {
    if (!open.has(id)) throw new Error(`node ${id} unreachable even with gates open`);
  }
  const mustReachClosed: [string, { x: number; z: number }][] = [
    ["extraction", layout.extractionZone],
    ["keycard", layout.keycardPos],
    ["breaker", layout.breakerPos],
  ];
  for (const [what, pos] of mustReachClosed) {
    const n = nearestNode(nav, pos.x, pos.z);
    if (!closed.has(n)) {
      throw new Error(`${what} is behind a gate (nearest node ${n} not reachable gates-closed)`);
    }
  }
  for (const stop of route) {
    if (!closed.has(stop)) throw new Error(`patrol stop ${stop} not reachable gates-closed`);
  }

  // 4. spawn <-> extraction meaningfully far apart (graph distance)
  const extractNode = nearestNode(nav, layout.extractionZone.x, layout.extractionZone.z);
  const d = nav.distance(spawnNode, extractNode);
  if (d < MIN_SPAWN_EXTRACT_DIST) {
    throw new Error(`spawn->extraction graph distance ${d.toFixed(1)}m < ${MIN_SPAWN_EXTRACT_DIST}m`);
  }
}

/**
 * Spread-constrained loot pick: locked jackpot always in, rest greedy.
 * Bigger hauls (multiplayer) relax spacing in steps rather than failing;
 * if candidates simply run out, returns what fits (quota clamps to it).
 */
export function pickLoot(
  candidates: LootCandidate[],
  count = LOOT_COUNT,
  spacing = MIN_LOOT_SPACING
): LootCandidate[] {
  const locked = candidates.filter((c) => c.locked);
  for (const sp of [spacing, spacing - 1.2, 2.2, 0]) {
    const rest = shuffled(candidates.filter((c) => !c.locked));
    const picked = [...locked];
    for (const c of rest) {
      if (picked.length >= count) break;
      const ok = picked.every((p) => Math.hypot(p.x - c.x, p.z - c.z) >= sp);
      if (ok) picked.push(c);
    }
    if (picked.length >= count) return picked;
    if (sp === 0) return picked; // candidates exhausted: best effort
  }
  return locked;
}

export function generateLayout(pinned?: LayoutDescriptor): GeneratedLayout {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    const descriptor = pinned ?? randomDescriptor();
    try {
      const layout = buildLayout(descriptor);
      const los = createLos(layout.boxes, layout.gateDoors);
      const nav = createNav(layout.navNodes, layout.navEdges, los);
      validateLayout(layout, los, nav);
      const lootPicks = pickLoot(layout.lootCandidates);
      if (lootPicks.length < LOOT_COUNT) {
        throw new Error(`only ${lootPicks.length}/${LOOT_COUNT} solo loot spots fit`);
      }
      return { descriptor, layout, los, nav, lootPicks };
    } catch (err) {
      // even for a pinned descriptor, retry: the loot pick is randomized
      lastError = err;
    }
  }
  throw new Error(`layout generation failed: ${String(lastError)}`);
}
