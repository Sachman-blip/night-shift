// Server-authoritative enemy over a generated layout. All perception and
// movement happen here; the client only receives position/yaw/state.

import type { GateId } from "../../../shared/map";
import type { LosSystem, Rect } from "./los";
import type { NavSystem, IsGateOpen } from "./nav";
import type { Enemy, Player } from "../schema/GameState";
import {
  TORCH_VISION_SCALE,
  CROUCH_VISION_SCALE,
} from "../../../shared/messages";

// Variant tuning only - identical state machine, different senses/speeds.
// Player speeds for reference: crouch 1.55 / walk 3.4 / sprint 5.8.
// `hear` is the radius against a NORMAL walking player; it is scaled by the
// player's live noise factor (0.25 idle .. 1.75 sprinting), so the numbers
// below are the middle of a range rather than a fixed bubble.
//
// Chase speeds sit deliberately between WALK and SPRINT: walking away from a
// hunt never works, sprinting always opens a gap. The gap is small enough
// (1.3 m/s at worst) that one stamina bar buys a corner, not a lap of the map.
export const ENEMY_VARIANTS = {
  // baseline hunter: sees far, hears little
  stalker: { patrol: 1.5, search: 2.0, chase: 3.8, hear: 4, vision: 13 },
  // near-blind, hears you through walls from across a room - sneak or die
  listener: { patrol: 1.25, search: 1.8, chase: 3.5, hear: 9, vision: 8 },
  // fast and twitchy: still the one you cannot outlast, but poor senses
  sprinter: { patrol: 1.9, search: 2.2, chase: 4.5, hear: 3, vision: 11 },
} as const;
export type EnemyVariant = keyof typeof ENEMY_VARIANTS;
const VISION_COS = Math.cos((50 * Math.PI) / 180);
const LOSE_SIGHT_MS = 1800;
// Beat of stillness when a hunt starts: it locks onto you and *waits* before
// coming. Reads as a decision being made, and hands you the head start that
// makes breaking line of sight a real option.
const NOTICE_FREEZE_MS = 450;
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
  private noticeUntil = 0;
  private tune: (typeof ENEMY_VARIANTS)[EnemyVariant] = ENEMY_VARIANTS.stalker;

  constructor(private enemy: Enemy, private world: EnemyWorld) {
    this.reset("stalker");
  }

  /**
   * Swap in a freshly generated layout's navigation/sight systems. Used when
   * a new shift re-rolls the map: the enemy id stays valid, so client-side
   * views for it survive the rebuild.
   */
  setWorld(world: EnemyWorld) {
    this.world = world;
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
    this.noticeUntil = 0;
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
    this.noticeUntil = 0;
    this.toPatrol();
  }

  /** Ground distance from this monster to a point - used to keep spawns safe. */
  distanceTo(x: number, z: number): number {
    return Math.hypot(this.enemy.x - x, this.enemy.z - z);
  }

  private closedGateRects(): Rect[] {
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
    const gates = this.closedGateRects();

    for (const t of players) {
      if (t.invulnerable || t.player.downed) continue;
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
      if (t.invulnerable || t.player.downed) continue;
      const d = Math.hypot(t.player.x - e.x, t.player.z - e.z);
      if (d < nearestD && this.canDetect(t.player, d, gates)) {
        nearest = t;
        nearestD = d;
      }
    }
    if (nearest) {
      if (e.aiState !== "chase") this.noticeUntil = now + NOTICE_FREEZE_MS;
      e.aiState = "chase";
      this.lastKnown.x = nearest.player.x;
      this.lastKnown.z = nearest.player.z;
      this.lastDetectedAt = now;
    }

    switch (e.aiState) {
      case "chase": {
        // the beat before the sprint: stand still, but turn to face you
        if (now < this.noticeUntil) {
          this.faceToward(this.lastKnown.x, this.lastKnown.z);
          break;
        }
        this.navigateToward(this.lastKnown.x, this.lastKnown.z, this.tune.chase, dt, gates);
        if (now - this.lastDetectedAt > LOSE_SIGHT_MS) {
          e.aiState = "search";
          this.searchArrivedAt = null;
        }
        break;
      }
      case "search": {
        const arrived = this.navigateToward(
          this.lastKnown.x, this.lastKnown.z, this.tune.search, dt, gates
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
        if (this.navigateToward(stop.x, stop.z, this.tune.patrol, dt, gates)) {
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

  private canDetect(p: Player, d: number, blockers: Rect[]): boolean {
    // Hearing ignores walls (the listener variant is built on that) but is
    // scaled by how much noise the player is actually making right now.
    if (d <= this.tune.hear * p.noise) return true;

    let vision = this.tune.vision;
    if (p.torch) vision *= TORCH_VISION_SCALE;   // a lit beam is a beacon
    if (p.crouching) vision *= CROUCH_VISION_SCALE; // a low silhouette is not
    if (d > vision) return false;

    const e = this.enemy;
    const fx = -Math.sin(e.yaw);
    const fz = -Math.cos(e.yaw);
    const dot = (fx * (p.x - e.x) + fz * (p.z - e.z)) / d;
    if (dot < VISION_COS) return false;
    return this.world.los.losClear(e.x, e.z, p.x, p.z, blockers);
  }

  private navigateToward(
    tx: number, tz: number, speed: number, dt: number, gates: Rect[]
  ): boolean {
    const e = this.enemy;
    const { los, nav, isGateOpen } = this.world;
    if (los.losClear(e.x, e.z, tx, tz, gates)) {
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
      los.losClear(e.x, e.z, nav.nodes[path[i + 1]].x, nav.nodes[path[i + 1]].z, gates)
    ) {
      i++;
    }
    const n = nav.nodes[path[i]];
    this.stepToward(n.x, n.z, speed, dt);
    return false;
  }

  /** Turn to look at a point without moving an inch. */
  private faceToward(tx: number, tz: number) {
    const e = this.enemy;
    const dx = tx - e.x;
    const dz = tz - e.z;
    if (dx === 0 && dz === 0) return;
    e.yaw = Math.atan2(-dx, -dz);
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
