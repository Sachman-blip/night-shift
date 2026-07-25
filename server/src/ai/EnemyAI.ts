// Server-authoritative enemy over a generated layout. All perception and
// movement happen here; the client only receives position/yaw/state.

import type { GateId } from "../../../shared/map";
import { segmentHitsRect, type LosSystem, type Rect } from "./los";
import type { NavSystem, IsGateOpen } from "./nav";
import type { Enemy, Player } from "../schema/GameState";
import {
  TORCH_VISION_SCALE,
  CROUCH_VISION_SCALE,
  DOOR_FORCE_SECONDS,
} from "../../../shared/messages";

// Variant tuning only - identical state machine, different senses/speeds.
// Player speeds for reference: crouch 1.55 / walk 3.4 / sprint 5.8.
// `hear` is the radius against a NORMAL walking player; it is scaled by the
// player's live noise factor (0.25 idle .. 1.75 sprinting), so the numbers
// below are the middle of a range rather than a fixed bubble.
export const ENEMY_VARIANTS = {
  // baseline hunter: sees far, hears little
  stalker: { patrol: 1.7, search: 2.4, chase: 4.3, hear: 4, vision: 13 },
  // near-blind, hears you through walls from across a room - sneak or die
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
/** Something already hunting you tears through a door faster. */
const CHASE_FORCE_SCALE = 0.65;

export interface TrackedPlayer {
  sessionId: string;
  player: Player;
  invulnerable: boolean;
}

/** A shut swinging door, with the index the room uses to open it. */
export interface DoorBlocker {
  index: number;
  rect: Rect;
}

export interface EnemyWorld {
  los: LosSystem;
  nav: NavSystem;
  route: string[];
  spawn: { x: number; z: number };
  isGateOpen: IsGateOpen;
  /** Doors that are shut right now: they hide players and stop movement. */
  closedDoors: () => DoorBlocker[];
  /** Tear a door off its latch (index into the layout's door list). */
  forceDoor: (index: number) => void;
}

export class EnemyAI {
  private routeIndex = 0;
  private lastKnown = { x: 0, z: 0 };
  private lastDetectedAt = 0;
  private searchArrivedAt: number | null = null;
  private tune: (typeof ENEMY_VARIANTS)[EnemyVariant] = ENEMY_VARIANTS.stalker;
  /** Door the last movement step ran into, if any (reset every update). */
  private blockedDoor: number | null = null;
  private forcingIndex: number | null = null;
  private forceProgress = 0;

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
    this.enemy.forcing = false;
    this.lastKnown = { x: spawn.x, z: spawn.z };
    this.lastDetectedAt = 0;
    this.searchArrivedAt = null;
    this.blockedDoor = null;
    this.forcingIndex = null;
    this.forceProgress = 0;
    // resume at the route stop nearest this enemy's own spawn, so multiple
    // enemies sharing the route start spread out instead of converging
    this.toPatrol();
  }

  /** Hard reposition (post-kill scatter): appear elsewhere, resume patrol. */
  relocateTo(x: number, z: number) {
    this.enemy.x = x;
    this.enemy.z = z;
    this.enemy.aiState = "patrol";
    this.enemy.forcing = false;
    this.searchArrivedAt = null;
    this.forcingIndex = null;
    this.forceProgress = 0;
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
    // Gates are permanent barriers the AI routes around. Doors are not: it
    // navigates as though they were open, walks into whichever one is shut,
    // and tears it off - which is the entire point of closing one.
    const gates = this.closedGateRects();
    const doors = this.world.closedDoors();
    const sightBlockers = doors.length
      ? [...gates, ...doors.map((d) => d.rect)]
      : gates;
    this.blockedDoor = null;

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
      if (d < nearestD && this.canDetect(t.player, d, sightBlockers)) {
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
        this.navigateToward(this.lastKnown.x, this.lastKnown.z, this.tune.chase, dt, gates, doors);
        if (now - this.lastDetectedAt > LOSE_SIGHT_MS) {
          e.aiState = "search";
          this.searchArrivedAt = null;
        }
        break;
      }
      case "search": {
        const arrived = this.navigateToward(
          this.lastKnown.x, this.lastKnown.z, this.tune.search, dt, gates, doors
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
        if (this.navigateToward(stop.x, stop.z, this.tune.patrol, dt, gates, doors)) {
          this.routeIndex = (this.routeIndex + 1) % route.length;
        }
      }
    }

    this.updateForcing(dt);
  }

  /** Grind down whichever door the movement step ran into this tick. */
  private updateForcing(dt: number) {
    const e = this.enemy;
    if (this.blockedDoor === null) {
      this.forcingIndex = null;
      this.forceProgress = 0;
      e.forcing = false;
      return;
    }
    if (this.forcingIndex !== this.blockedDoor) {
      this.forcingIndex = this.blockedDoor;
      this.forceProgress = 0;
    }
    e.forcing = true;
    this.forceProgress += dt;
    const needed =
      DOOR_FORCE_SECONDS * (e.aiState === "chase" ? CHASE_FORCE_SCALE : 1);
    if (this.forceProgress >= needed) {
      this.world.forceDoor(this.forcingIndex);
      this.forcingIndex = null;
      this.forceProgress = 0;
      e.forcing = false;
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
    tx: number, tz: number, speed: number, dt: number,
    gates: Rect[], doors: DoorBlocker[]
  ): boolean {
    const e = this.enemy;
    const { los, nav, isGateOpen } = this.world;
    if (los.losClear(e.x, e.z, tx, tz, gates)) {
      return this.stepToward(tx, tz, speed, dt, doors);
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
    this.stepToward(n.x, n.z, speed, dt, doors);
    return false;
  }

  private stepToward(
    tx: number, tz: number, speed: number, dt: number, doors: DoorBlocker[]
  ): boolean {
    const e = this.enemy;
    const dx = tx - e.x;
    const dz = tz - e.z;
    const d = Math.hypot(dx, dz);
    if (d <= ARRIVE_DIST) return true;
    const step = Math.min(speed * dt, d);
    const nx = e.x + (dx / d) * step;
    const nz = e.z + (dz / d) * step;
    // face the way it wants to go even while a door holds it back
    e.yaw = Math.atan2(-dx, -dz);
    for (const door of doors) {
      if (segmentHitsRect(e.x, e.z, nx, nz, door.rect)) {
        this.blockedDoor = door.index;
        return false;
      }
    }
    e.x = nx;
    e.z = nz;
    return false;
  }
}
