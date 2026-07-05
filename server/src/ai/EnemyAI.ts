// Server-authoritative enemy over a generated layout. All perception and
// movement happen here; the client only receives position/yaw/state.

import type { GateId } from "../../../shared/map";
import type { LosSystem, Rect } from "./los";
import type { NavSystem, IsGateOpen } from "./nav";
import type { Enemy, Player } from "../schema/GameState";

// Variant tuning only â€” identical state machine, different senses/speeds.
// Player speeds for reference: walk 3.4 / sprint 5.8 (stamina-limited).
export const ENEMY_VARIANTS = {
  // baseline hunter: sees far, hears little
  stalker: { patrol: 1.7, search: 2.4, chase: 4.3, hear: 4, vision: 13 },
  // near-blind, hears you through walls from across a room â€” sneak or die
  listener: { patrol: 1.4, search: 2.2, chase: 4.0, hear: 9, vision: 8 },
  // fast and twitchy: chase nearly matches sprint, but poor senses
  sprinter: { patrol: 2.2, search: 2.6, chase: 5.2, hear: 3, vision: 11 },
} as const;
export type EnemyVariant = keyof typeof ENEMY_VARIANTS;
const VISION_COS = Math.cos((50 * Math.PI) / 180);
const LOSE_SIGHT_MS = 2500;
const SEARCH_LINGER_MS = 4000;
const KILL_RADIUS = 1.1;
const KILL_HEIGHT = 1.6;
const ARRIVE_DIST = 0.3;
const SCAN_SPEED = 2.4;

export interface TrackedPlayer {
  sessionId: string;
  player: Player;
  invulnerable: boolean;
}

export interface EnemyWorld {
  los: LosSystem;
  nav: NavSystem;
  route: string[];
  spawn: { x: number; z: number };
  isGateOpen: IsGateOpen;
}

export class EnemyAI {
  private routeIndex = 0;
  private lastKnown = { x: 0, z: 0 };
  private lastDetectedAt = 0;
  private searchArrivedAt: number | null = null;
  private tune: (typeof ENEMY_VARIANTS)[EnemyVariant] = ENEMY_VARIANTS.stalker;

  constructor(private enemy: Enemy, private world: EnemyWorld) {
    this.reset("stalker");
  }

  reset(variant?: EnemyVariant) {
    if (variant) {
      this.tune = ENEMY_VARIANTS[variant];
      this.enemy.variant = variant;
    }
    const { spawn } = this.world;
    this.enemy.x = spawn.x;
    this.enemy.z = spawn.z;
    this.enemy.y = 1.05;
    this.enemy.yaw = 0;
    this.enemy.aiState = "patrol";
    this.lastKnown = { x: spawn.x, z: spawn.z };
    this.lastDetectedAt = 0;
    this.searchArrivedAt = null;
    // resume at the route stop nearest this enemy's own spawn, so multiple
    // enemies sharing the route start spread out instead of converging
    this.toPatrol();
  }

  /** Hard reposition (post-kill scatter): appear elsewhere, resume patrol. */
  relocateTo(x: number, z: number) {
    this.enemy.x = x;
    this.enemy.z = z;
    this.enemy.aiState = "patrol";
    this.searchArrivedAt = null;
    this.toPatrol();
  }

  /** Ground distance from this monster to a point — used to keep spawns safe. */
  distanceTo(x: number, z: number): number {
    return Math.hypot(this.enemy.x - x, this.enemy.z - z);
  }

  private closedDoorRects(): Rect[] {
    const rects: Rect[] = [];
    const gateRects = this.world.los.gateRects;
    for (const gate of Object.keys(gateRects) as GateId[]) {
      if (!this.world.isGateOpen(gate)) rects.push(...gateRects[gate]);
    }
    return rects;
  }

  update(
    dt: number,
    now: number,
    players: TrackedPlayer[],
    kill: (sessionId: string) => void
  ) {
    const e = this.enemy;
    const closed = this.closedDoorRects();

    for (const t of players) {
      if (t.invulnerable) continue;
      const d = Math.hypot(t.player.x - e.x, t.player.z - e.z);
      if (d <= KILL_RADIUS && Math.abs(t.player.y - e.y) < KILL_HEIGHT) {
        kill(t.sessionId);
        this.toPatrol();
        return;
      }
    }

    let nearest: TrackedPlayer | null = null;
    let nearestD = Infinity;
    for (const t of players) {
      if (t.invulnerable) continue;
      const d = Math.hypot(t.player.x - e.x, t.player.z - e.z);
      if (d < nearestD && this.canDetect(t.player, d, closed)) {
        nearest = t;
        nearestD = d;
      }
    }
    if (nearest) {
      e.aiState = "chase";
      this.lastKnown.x = nearest.player.x;
      this.lastKnown.z = nearest.player.z;
      this.lastDetectedAt = now;
    }

    switch (e.aiState) {
      case "chase": {
        this.navigateToward(this.lastKnown.x, this.lastKnown.z, this.tune.chase, dt, closed);
        if (now - this.lastDetectedAt > LOSE_SIGHT_MS) {
          e.aiState = "search";
          this.searchArrivedAt = null;
        }
        break;
      }
      case "search": {
        const arrived = this.navigateToward(
          this.lastKnown.x, this.lastKnown.z, this.tune.search, dt, closed
        );
        if (arrived) {
          if (this.searchArrivedAt === null) this.searchArrivedAt = now;
          e.yaw += SCAN_SPEED * dt;
        }
        if (this.searchArrivedAt !== null && now - this.searchArrivedAt > SEARCH_LINGER_MS) {
          this.toPatrol();
        }
        break;
      }
      default: {
        const { route, nav } = this.world;
        const stop = nav.nodes[route[this.routeIndex]];
        if (this.navigateToward(stop.x, stop.z, this.tune.patrol, dt, closed)) {
          this.routeIndex = (this.routeIndex + 1) % route.length;
        }
      }
    }
  }

  private toPatrol() {
    this.enemy.aiState = "patrol";
    this.searchArrivedAt = null;
    const { route, nav } = this.world;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < route.length; i++) {
      const n = nav.nodes[route[i]];
      const d = Math.hypot(n.x - this.enemy.x, n.z - this.enemy.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.routeIndex = best;
  }

  private canDetect(p: Player, d: number, closed: Rect[]): boolean {
    if (d <= this.tune.hear) return true;
    if (d > this.tune.vision) return false;
    const e = this.enemy;
    const fx = -Math.sin(e.yaw);
    const fz = -Math.cos(e.yaw);
    const dot = (fx * (p.x - e.x) + fz * (p.z - e.z)) / d;
    if (dot < VISION_COS) return false;
    return this.world.los.losClear(e.x, e.z, p.x, p.z, closed);
  }

  private navigateToward(
    tx: number, tz: number, speed: number, dt: number, closed: Rect[]
  ): boolean {
    const e = this.enemy;
    const { los, nav, isGateOpen } = this.world;
    if (los.losClear(e.x, e.z, tx, tz, closed)) {
      return this.stepToward(tx, tz, speed, dt);
    }
    const path = nav.findPath(
      nav.nearestVisibleNode(e.x, e.z),
      nav.nearestVisibleNode(tx, tz),
      isGateOpen
    );
    let i = 0;
    while (
      i < path.length - 1 &&
      los.losClear(e.x, e.z, nav.nodes[path[i + 1]].x, nav.nodes[path[i + 1]].z, closed)
    ) {
      i++;
    }
    const n = nav.nodes[path[i]];
    this.stepToward(n.x, n.z, speed, dt);
    return false;
  }

  private stepToward(tx: number, tz: number, speed: number, dt: number): boolean {
    const e = this.enemy;
    const dx = tx - e.x;
    const dz = tz - e.z;
    const d = Math.hypot(dx, dz);
    if (d <= ARRIVE_DIST) return true;
    const step = Math.min(speed * dt, d);
    e.x += (dx / d) * step;
    e.z += (dz / d) * step;
    e.yaw = Math.atan2(-dx, -dz);
    return false;
  }
}

