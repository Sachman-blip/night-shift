import { Room, type Client } from "colyseus";
import { GameState, Player, Loot, Enemy } from "../schema/GameState";
import {
  EnemyAI,
  ENEMY_VARIANTS,
  type EnemyVariant,
  type EnemyWorld,
  type TrackedPlayer,
} from "../ai/EnemyAI";
import { generateLayout, type GeneratedLayout } from "../layout";
import {
  MSG,
  PATCH_RATE_MS,
  MAX_PLAYERS,
  MAX_NAME_LENGTH,
  WALK_SPEED,
  SPRINT_SPEED,
  STAMINA_DRAIN_PER_S,
  STAMINA_REGEN_PER_S,
  STAMINA_MIN_SPRINT,
  SPRINT_DETECT_SPEED,
  CROUCH_DETECT_SPEED,
  NOISE_IDLE,
  noiseForSpeed,
  BATTERY_DRAIN_PER_S,
  BASE_CELLS,
  REVIVE_RADIUS,
  REVIVE_SECONDS,
  REVIVE_DECAY_PER_S,
  REVIVE_INVULN_MS,
  BLEED_OUT_SECONDS,
  BLEED_TIME_PENALTY,
  type MoveMessage,
  type DeathMessage,
  type TeleportMessage,
  type BuyMessage,
} from "../../../shared/messages";
import {
  MAP_BOUNDS,
  INTERACT_RADIUS,
  type GateId,
  type LayoutDescriptor,
} from "../../../shared/map";
import {
  LOOT_GROUND_Y,
  PICKUP_RADIUS,
  SOLO_MODE,
  MULTI_MODE,
  MAX_ENEMIES,
  planShift,
  lootValue,
  creditsEarned,
  upgradeCost,
  carryCapacityFor,
  noiseScaleFor,
  staminaDrainScaleFor,
} from "../../../shared/loot";
import { pickLoot } from "../layout";
import type { LootCandidate } from "../../../shared/map";

// No ambiguous chars (0/O, 1/I/L) so codes are easy to read out loud.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
const CODE_REGISTRY = "roomCodes";

const SIM_INTERVAL_MS = 50;
const RESPAWN_INVULN_MS = 4000;
// Grace bubble at the START of a round too, so a monster patrolling past a
// spawn can't kill players the instant the shift begins.
const START_INVULN_MS = 3500;
const IGNORE_MOVES_MS = 300;
// A respawn/round-start spawn is only "safe" if no monster is inside this
// bubble — it exceeds the farthest-seeing variant's vision (stalker: 13) so a
// cleared enemy can't immediately re-detect and re-camp the spawn.
const SAFE_SPAWN_RADIUS = 16;
// Post-scatter, a monster lands at least this far from every player and the
// kill site (also > max vision, so it can't just turn around and re-acquire).
const SCATTER_MIN_DIST = 15;
/** Revive progress decays once the rescuer has been silent this long. */
const REVIVE_STALE_MS = 400;

const DROP_SCATTER: [number, number][] = [
  [0.6, 0], [-0.45, 0.45], [0, -0.6], [0.45, 0.45],
];

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

interface PlayerMeta {
  spawn: { x: number; z: number };
  invulnUntil: number;
  ignoreMovesUntil: number;
  lastX: number;
  lastZ: number;
  lastMoveAt: number;
  staminaLocked: boolean;
  moveBudget: number;
  /** When this player last pushed revive progress into somebody. */
  lastReviveAt: number;
  /** When somebody last fed revive progress into THIS player. */
  reviveFedAt: number;
}

interface CreateOptions {
  name?: string;
  quota?: number;
  roundSeconds?: number;
  /** Test/debug: freeze the enemy for pacing and screenshot runs. */
  noEnemy?: boolean;
  /** Test/debug: skip the speed clamp so test harnesses can teleport. */
  freeMove?: boolean;
  /** Test/debug: pin the exact map arrangement (also disables re-rolling). */
  layout?: LayoutDescriptor;
  /** Test/debug: pin the monster type (normally rolled per round). */
  variant?: EnemyVariant;
  /** How many monsters roam the facility (default 2). */
  enemies?: number;
}

export class GameRoom extends Room<GameState> {
  maxClients = MAX_PLAYERS;
  state = new GameState();

  private meta = new Map<string, PlayerMeta>();
  private ais: EnemyAI[] = [];
  private gen!: GeneratedLayout;
  private roundSeconds = SOLO_MODE.seconds;
  private roundEndsAt = 0;
  private optSeconds = 0;
  private optQuota = 0;
  private lootPicks: LootCandidate[] = [];
  private enemyEnabled = true;
  private freeMove = false;
  private pinnedVariant?: EnemyVariant;
  private pinnedLayout?: LayoutDescriptor;
  private baseEnemies = 2;
  private enemiesPinned = false;

  async onCreate(options: CreateOptions = {}) {
    this.setPatchRate(PATCH_RATE_MS);
    this.roomId = await this.generateRoomCode();

    // 0 = "use per-mode defaults, decided at each round start"
    this.optSeconds = clamp(Math.floor(Number(options.roundSeconds)) || 0, 0, 1800);
    this.optQuota = clamp(Math.floor(Number(options.quota)) || 0, 0, 400);
    this.enemyEnabled = !options.noEnemy;
    this.freeMove = !!options.freeMove;
    this.pinnedLayout = options.layout;
    if (options.variant && options.variant in ENEMY_VARIANTS) {
      this.pinnedVariant = options.variant;
    }

    // assemble + validate this room's first map arrangement
    this.gen = generateLayout(this.pinnedLayout);
    this.state.layout = JSON.stringify(this.gen.descriptor);

    // A pinned enemy count (tests) holds fixed; otherwise it's the shift-1
    // baseline that escalation grows from. Monsters share the patrol route
    // but spawn spread across it; ensureEnemyCount() adds them as shifts climb.
    const rawEnemies = Math.floor(Number(options.enemies));
    this.enemiesPinned = Number.isFinite(rawEnemies) && rawEnemies >= 1;
    this.baseEnemies = clamp(rawEnemies || 2, 1, MAX_ENEMIES);
    this.resetRound();
    this.setSimulationInterval((dtMs) => this.simTick(dtMs), SIM_INTERVAL_MS);

    this.onMessage(MSG.Move, (client, msg: MoveMessage) => {
      if (this.state.phase !== "active") return;
      const p = this.state.players.get(client.sessionId);
      // on the floor you don't move: position is frozen where you fell
      if (!p || p.downed || typeof msg !== "object" || msg === null) return;

      const m = this.meta.get(client.sessionId);
      if (m && m.ignoreMovesUntil > Date.now()) return;

      const { x, y, z, yaw, pitch, torch } = msg;
      if (![x, y, z, yaw, pitch].every(Number.isFinite)) return;
      const wantsCrouch = !!msg.crouch;

      // Movement is client-authoritative (co-op, no PvP) but SPEED is not:
      // stamina is simulated from observed 2D speed, and a token-bucket
      // distance budget clamps anything faster than the current legal max.
      const now = Date.now();
      let nx = clamp(x, MAP_BOUNDS.minX, MAP_BOUNDS.maxX);
      let nz = clamp(z, MAP_BOUNDS.minZ, MAP_BOUNDS.maxZ);
      if (m) {
        const dt = Math.min(Math.max((now - m.lastMoveAt) / 1000, 0.04), 0.25);
        const dx = nx - m.lastX;
        const dz = nz - m.lastZ;
        const dist = Math.hypot(dx, dz);
        const speed = dist / dt;

        const drain =
          STAMINA_DRAIN_PER_S * staminaDrainScaleFor(this.upgradeLevel("lungs"));
        if (speed > SPRINT_DETECT_SPEED) {
          p.stamina = Math.max(0, p.stamina - drain * dt);
          if (p.stamina <= 0) m.staminaLocked = true;
        } else {
          p.stamina = Math.min(1, p.stamina + STAMINA_REGEN_PER_S * dt);
          if (p.stamina >= STAMINA_MIN_SPRINT) m.staminaLocked = false;
        }

        // Noise comes from the speed we OBSERVE, never from the flag the
        // client sent: claiming to crouch while moving at sprint pace picks
        // the loud tier anyway, so there is nothing to gain by lying.
        p.crouching = wantsCrouch && speed <= CROUCH_DETECT_SPEED;
        p.noise =
          noiseForSpeed(speed, wantsCrouch) *
          noiseScaleFor(this.upgradeLevel("boots"));

        if (!this.freeMove) {
          const maxSpeed = m.staminaLocked ? WALK_SPEED : SPRINT_SPEED;
          m.moveBudget = Math.min(m.moveBudget + maxSpeed * dt, maxSpeed * 0.35);
          if (dist > m.moveBudget + 0.01) {
            nx = m.lastX + (dx / dist) * m.moveBudget;
            nz = m.lastZ + (dz / dist) * m.moveBudget;
            m.moveBudget = 0;
          } else {
            m.moveBudget -= dist;
          }
        }
        m.lastX = nx;
        m.lastZ = nz;
        m.lastMoveAt = now;
      }

      p.x = nx;
      p.y = clamp(y, 0, MAP_BOUNDS.yMax);
      p.z = nz;
      p.yaw = yaw;
      p.pitch = clamp(pitch, -1.6, 1.6);
      // a dead cell means a dead beam, whatever the client believes
      p.torch = !!torch && p.battery > 0;
    });

    this.onMessage(MSG.Pickup, (client) => {
      if (this.state.phase !== "active") return;
      const p = this.state.players.get(client.sessionId);
      if (!p || p.downed) return;

      const { keycardPos, breakerPos } = this.gen.layout;
      if (
        !this.state.keycardTaken &&
        Math.hypot(keycardPos.x - p.x, keycardPos.z - p.z) <= INTERACT_RADIUS
      ) {
        this.state.keycardTaken = true;
        this.state.archivesUnlocked = true;
        console.log(`[room ${this.roomId}] ${p.name} took the keycard — archives unlocked`);
        return;
      }
      if (
        !this.state.shortcutOpen &&
        Math.hypot(breakerPos.x - p.x, breakerPos.z - p.z) <= INTERACT_RADIUS
      ) {
        this.state.shortcutOpen = true;
        console.log(`[room ${this.roomId}] ${p.name} rerouted power — shutter open`);
        return;
      }

      if (p.carrying >= this.carryCapacity()) return;
      let best: Loot | null = null;
      let bestD = PICKUP_RADIUS;
      this.state.loot.forEach((l) => {
        if (l.carrier !== "" || l.extracted) return;
        const d = Math.hypot(l.x - p.x, l.z - p.z);
        if (d <= bestD && Math.abs(l.y - p.y) < 2) {
          best = l;
          bestD = d;
        }
      });
      if (best) {
        (best as Loot).carrier = client.sessionId;
        p.carrying++;
      }
    });

    this.onMessage(MSG.Revive, (client) => this.feedRevive(client.sessionId));

    this.onMessage(MSG.Swap, (client) => {
      if (this.state.phase !== "active") return;
      const p = this.state.players.get(client.sessionId);
      if (!p || p.downed || p.cells <= 0 || p.battery > 0.98) return;
      p.cells--;
      p.battery = 1;
    });

    this.onMessage(MSG.Buy, (client, msg: BuyMessage) => {
      // the shop is only open between shifts
      if (this.state.phase !== "ended") return;
      if (!msg || typeof msg.id !== "string") return;
      const level = this.upgradeLevel(msg.id);
      const cost = upgradeCost(msg.id, level);
      if (cost === null || cost > this.state.credits) return;
      this.state.credits -= cost;
      this.state.upgrades.set(msg.id, level + 1);
      // cells are gear rather than a stat — hand them out on the spot
      if (msg.id === "cells") {
        this.state.players.forEach((p) => (p.cells = this.cellsPerPlayer()));
      }
      const who = this.state.players.get(client.sessionId)?.name ?? client.sessionId;
      console.log(`[room ${this.roomId}] ${who} bought ${msg.id} lv${level + 1} (-${cost})`);
    });

    // WebRTC signaling relay: opaque payloads between peers in this room.
    // The server never inspects SDP/ICE — it only validates the target.
    this.onMessage(MSG.Rtc, (client, msg: { to?: string; data?: unknown }) => {
      if (!msg || typeof msg.to !== "string" || msg.data === undefined) return;
      const target = this.clients.find((c) => c.sessionId === msg.to);
      target?.send(MSG.Rtc, { from: client.sessionId, data: msg.data });
    });

    this.onMessage(MSG.Restart, () => {
      if (this.state.phase === "ended") {
        // clearing a shift advances to the next, harder one; failing repeats it
        if (this.state.win) this.state.shift++;
        console.log(`[room ${this.roomId}] shift ${this.state.shift}`);
        // every shift is a different arrangement of the building — the point
        // of the chunk system was never to show the same map twice
        this.resetRound(true);
      }
    });

    console.log(
      `[room ${this.roomId}] created (shift ${this.state.shift}, quota ${this.state.quota}, ` +
      `${this.roundSeconds}s, ${this.state.enemies.size} enemies, layout ${this.state.layout})`
    );
  }

  // ---------- upgrades ----------

  private upgradeLevel(id: string): number {
    return this.state.upgrades.get(id) ?? 0;
  }

  private carryCapacity(): number {
    return carryCapacityFor(this.upgradeLevel("capacity"));
  }

  private cellsPerPlayer(): number {
    return BASE_CELLS + this.upgradeLevel("cells");
  }

  // ---------- downed & revive ----------

  /** Is anybody left standing who could pick this player up? */
  private hasRescuer(sessionId: string): boolean {
    let found = false;
    this.state.players.forEach((q, id) => {
      if (id !== sessionId && !q.downed) found = true;
    });
    return found;
  }

  private feedRevive(sessionId: string) {
    if (this.state.phase !== "active") return;
    const rescuer = this.state.players.get(sessionId);
    const rm = this.meta.get(sessionId);
    if (!rescuer || !rm || rescuer.downed) return;

    let targetId: string | null = null;
    let target: Player | null = null;
    let bestD = REVIVE_RADIUS;
    this.state.players.forEach((q, id) => {
      if (id === sessionId || !q.downed) return;
      const d = Math.hypot(q.x - rescuer.x, q.z - rescuer.z);
      if (d <= bestD) {
        bestD = d;
        targetId = id;
        target = q;
      }
    });
    if (!targetId || !target) return;

    // Credit real elapsed time rather than one tick per message, so the
    // revive takes REVIVE_SECONDS regardless of how fast a client sends.
    const now = Date.now();
    const dt = Math.min(Math.max((now - rm.lastReviveAt) / 1000, 0), 0.25);
    rm.lastReviveAt = now;

    const tm = this.meta.get(targetId);
    if (tm) tm.reviveFedAt = now;
    const p = target as Player;
    p.reviveProgress = Math.min(1, p.reviveProgress + dt / REVIVE_SECONDS);
    if (p.reviveProgress >= 1) this.reviveNow(targetId, p, now);
  }

  private reviveNow(sessionId: string, p: Player, now: number) {
    const m = this.meta.get(sessionId);
    p.downed = false;
    p.bleed = 0;
    p.reviveProgress = 0;
    if (m) {
      m.invulnUntil = now + REVIVE_INVULN_MS;
      m.lastX = p.x;
      m.lastZ = p.z;
      m.lastMoveAt = now;
      m.moveBudget = 1;
      m.staminaLocked = false;
    }
    p.stamina = Math.max(p.stamina, 0.4);
    // shoo anything hovering over the pile before they can even stand up
    this.clearSpawnArea({ x: p.x, z: p.z });
    console.log(`[room ${this.roomId}] ${p.name} was helped back up`);
  }

  // ---------- round lifecycle ----------

  private resetRound(reroll = false) {
    this.state.phase = "active";
    this.state.win = false;
    this.state.extractedTotal = 0;
    this.state.keycardTaken = false;
    this.state.archivesUnlocked = false;
    this.state.shortcutOpen = false;

    // A new shift is a new arrangement of the building. Tests that pinned a
    // descriptor keep theirs so their assertions stay meaningful.
    if (reroll && !this.pinnedLayout) {
      this.gen = generateLayout();
      this.state.layout = JSON.stringify(this.gen.descriptor);
    }

    // Base difficulty is the player-count mode (solo = 15 items / quota 24 /
    // 6min, crew = 22 / 44 / 10min); the current shift escalates on top of it.
    // Explicit room options still pin quota/time/enemies for tests.
    const mode = this.state.players.size >= 2 ? MULTI_MODE : SOLO_MODE;
    const plan = planShift(this.state.shift, mode, this.baseEnemies);
    this.lootPicks = pickLoot(
      this.gen.layout.lootCandidates,
      plan.loot,
      plan.loot >= 20 ? 3.2 : 4.5
    );
    // quota is a VALUE target, so it can never exceed what is on the floor
    const mapValue = this.lootPicks.reduce((sum, c) => sum + lootValue(c.kind), 0);
    this.state.quota = clamp(this.optQuota || plan.quota, 1, mapValue);
    this.roundSeconds = this.optSeconds || plan.seconds;
    this.roundEndsAt = Date.now() + this.roundSeconds * 1000;
    this.state.timeLeft = this.roundSeconds;
    this.spawnLoot();

    // deeper shifts bring more monsters (up to MAX_ENEMIES); a pinned count holds
    this.ensureEnemyCount(this.enemiesPinned ? this.baseEnemies : plan.enemies);
    // Re-point every AI at the current layout — after a re-roll the old nav
    // graph, sight system and patrol route are all stale.
    const total = this.ais.length;
    this.ais.forEach((ai, i) => ai.setWorld(this.makeEnemyWorld(i, total)));
    // new monsters are rolled every round — distinct variants when possible
    const variants = (Object.keys(ENEMY_VARIANTS) as EnemyVariant[]).sort(
      () => Math.random() - 0.5
    );
    this.ais.forEach((ai, i) => {
      ai.reset(
        i === 0 && this.pinnedVariant
          ? this.pinnedVariant
          : variants[i % variants.length]
      );
    });

    const now = Date.now();
    const spawnPoints = this.gen.layout.spawnPoints;
    let slot = 0;
    this.state.players.forEach((p, sessionId) => {
      const m = this.meta.get(sessionId);
      if (!m) return;
      // spawn ends flip between layouts, so re-seat everyone every round
      const spawn = spawnPoints[slot++ % spawnPoints.length];
      m.spawn = { x: spawn.x, z: spawn.z };
      p.x = spawn.x;
      p.y = 1.05;
      p.z = spawn.z;
      p.carrying = 0;
      p.extractedCount = 0;
      p.extractedValue = 0;
      p.deaths = 0;
      p.stamina = 1;
      p.crouching = false;
      p.noise = NOISE_IDLE;
      p.battery = 1;
      p.cells = this.cellsPerPlayer();
      p.downed = false;
      p.bleed = 0;
      p.reviveProgress = 0;
      // grace window so nobody dies before they've even gotten their bearings
      m.invulnUntil = now + START_INVULN_MS;
      m.ignoreMovesUntil = now + IGNORE_MOVES_MS;
      m.lastX = spawn.x;
      m.lastZ = spawn.z;
      m.lastMoveAt = now + IGNORE_MOVES_MS;
      m.staminaLocked = false;
      m.moveBudget = 1;
      m.lastReviveAt = now;
      m.reviveFedAt = 0;
      const tp: TeleportMessage = { x: spawn.x, z: spawn.z };
      this.clients.find((c) => c.sessionId === sessionId)?.send(MSG.Teleport, tp);
    });
    // now that everyone's placed, evict monsters camping any spawn point
    this.state.players.forEach((_, sessionId) => {
      const m = this.meta.get(sessionId);
      if (m) this.clearSpawnArea(m.spawn);
    });
  }

  /** Everything an EnemyAI needs to read the world it is currently in. */
  private makeEnemyWorld(index: number, total: number): EnemyWorld {
    const route = this.gen.layout.patrolRoute;
    const spawn =
      index === 0
        ? this.gen.layout.enemySpawn
        : this.gen.nav.nodes[route[Math.floor((route.length * index) / Math.max(total, 1))]];
    return {
      los: this.gen.los,
      nav: this.gen.nav,
      route,
      spawn,
      isGateOpen: (gate: GateId) =>
        gate === "archives" ? this.state.archivesUnlocked : this.state.shortcutOpen,
    };
  }

  /**
   * Grow the roster to `target` monsters (add-only, capped at MAX_ENEMIES).
   * Escalation never removes a monster mid-run, so client-side enemy views
   * for existing ids stay valid; only new ids ever appear.
   */
  private ensureEnemyCount(target: number) {
    const want = clamp(Math.floor(target), 1, MAX_ENEMIES);
    for (let i = this.ais.length; i < want; i++) {
      const e = new Enemy();
      this.state.enemies.set(`e${i}`, e);
      this.ais.push(new EnemyAI(e, this.makeEnemyWorld(i, want)));
    }
  }

  private spawnLoot() {
    this.state.loot.clear();
    this.lootPicks.forEach((s, i) => {
      const l = new Loot();
      l.kind = s.kind;
      l.x = s.x;
      l.y = LOOT_GROUND_Y;
      l.z = s.z;
      this.state.loot.set(`L${i}`, l);
    });
  }

  private endRound(win: boolean) {
    this.state.phase = "ended";
    this.state.win = win;
    const earned = creditsEarned(this.state.extractedTotal, win);
    this.state.credits += earned;
    // nobody stays on the floor through the debrief
    this.state.players.forEach((p) => {
      p.downed = false;
      p.bleed = 0;
      p.reviveProgress = 0;
    });
    console.log(
      `[room ${this.roomId}] round over: ${win ? "WIN" : "TIMEOUT"} ` +
      `(${this.state.extractedTotal}/${this.state.quota} value, +${earned} credits)`
    );
  }

  private simTick(dtMs: number) {
    if (this.state.phase !== "active") return;
    const now = Date.now();
    const dt = Math.min(dtMs, 100) / 1000;

    const left = Math.max(0, Math.ceil((this.roundEndsAt - now) / 1000));
    if (left !== this.state.timeLeft) this.state.timeLeft = left;
    if (left <= 0) {
      this.endRound(false);
      return;
    }

    this.tickPlayers(dt, now);

    const players: TrackedPlayer[] = [];
    this.state.players.forEach((player, sessionId) => {
      players.push({
        sessionId,
        player,
        invulnerable: (this.meta.get(sessionId)?.invulnUntil ?? 0) > now,
      });
    });

    if (this.enemyEnabled) {
      for (const ai of this.ais) {
        ai.update(dt, now, players, (sessionId) => {
          const victim = this.state.players.get(sessionId);
          const at = victim ? { x: victim.x, z: victim.z } : null;
          this.catchPlayer(sessionId, now);
          // the catcher vanishes to a random far patrol spot — no
          // camping the kill site, and no one knows where it went
          this.scatterEnemy(ai, at);
        });
      }
    }

    this.checkExtraction();
  }

  /** Battery burn, bleed-out, and revive decay. */
  private tickPlayers(dt: number, now: number) {
    this.state.players.forEach((p, sessionId) => {
      if (p.torch && p.battery > 0) {
        p.battery = Math.max(0, p.battery - BATTERY_DRAIN_PER_S * dt);
        if (p.battery <= 0) p.torch = false;
      }
      if (!p.downed) return;

      const m = this.meta.get(sessionId);
      if (m && now - m.reviveFedAt > REVIVE_STALE_MS && p.reviveProgress > 0) {
        p.reviveProgress = Math.max(0, p.reviveProgress - REVIVE_DECAY_PER_S * dt);
      }
      p.bleed = Math.max(0, p.bleed - dt);
      if (p.bleed <= 0) {
        console.log(`[room ${this.roomId}] ${p.name} bled out`);
        this.respawn(sessionId, now);
      }
    });
  }

  private checkExtraction() {
    const zone = this.gen.layout.extractionZone;
    let banked = 0;
    this.state.players.forEach((p, sessionId) => {
      if (p.carrying === 0 || p.downed) return;
      if (Math.abs(p.x - zone.x) > zone.sx / 2) return;
      if (Math.abs(p.z - zone.z) > zone.sz / 2) return;

      let n = 0;
      let value = 0;
      this.state.loot.forEach((l) => {
        if (l.carrier === sessionId) {
          l.carrier = "";
          l.extracted = true;
          n++;
          value += lootValue(l.kind);
        }
      });
      p.carrying = 0;
      p.extractedCount += n;
      p.extractedValue += value;
      banked += value;
      console.log(`[room ${this.roomId}] ${p.name} banked ${n} item(s) worth ${value}`);
    });

    if (banked > 0) {
      this.state.extractedTotal += banked;
      if (this.state.extractedTotal >= this.state.quota) this.endRound(true);
    }
  }

  /** Random patrol node far from every player and from the kill site. */
  private scatterEnemy(ai: EnemyAI, killSpot: { x: number; z: number } | null) {
    const route = this.gen.layout.patrolRoute;
    const nodes = this.gen.nav.nodes;
    const farEnough = (n: { x: number; z: number }) => {
      if (killSpot && Math.hypot(n.x - killSpot.x, n.z - killSpot.z) < SCATTER_MIN_DIST) return false;
      let ok = true;
      this.state.players.forEach((p) => {
        if (Math.hypot(n.x - p.x, n.z - p.z) < SCATTER_MIN_DIST) ok = false;
      });
      return ok;
    };
    const candidates = route.map((id) => nodes[id]).filter(farEnough);
    const pool = candidates.length ? candidates : route.map((id) => nodes[id]);
    const spot = pool[Math.floor(Math.random() * pool.length)];
    ai.relocateTo(spot.x, spot.z);
  }

  /**
   * Push any monster loitering within SAFE_SPAWN_RADIUS of a spawn out to a far
   * patrol node. Combined with respawn invulnerability this guarantees you
   * always come back to a clear bubble instead of straight into a waiting mouth.
   */
  private clearSpawnArea(spawn: { x: number; z: number }) {
    for (const ai of this.ais) {
      if (ai.distanceTo(spawn.x, spawn.z) < SAFE_SPAWN_RADIUS) {
        this.scatterEnemy(ai, spawn);
      }
    }
  }

  private dropCarried(sessionId: string, x: number, z: number): number {
    let i = 0;
    this.state.loot.forEach((l) => {
      if (l.carrier !== sessionId) return;
      const [ox, oz] = DROP_SCATTER[i % DROP_SCATTER.length];
      l.carrier = "";
      l.x = clamp(x + ox, MAP_BOUNDS.minX, MAP_BOUNDS.maxX);
      l.z = clamp(z + oz, MAP_BOUNDS.minZ, MAP_BOUNDS.maxZ);
      l.y = LOOT_GROUND_Y;
      i++;
    });
    return i;
  }

  /**
   * Caught. You drop the haul where you fall and go down — a teammate has
   * REVIVE_SECONDS of holding interact to get you back up before you bleed
   * out. With nobody left standing there is no one to come for you, so the
   * floor is skipped and you respawn straight away (at the usual cost).
   */
  private catchPlayer(sessionId: string, now: number) {
    const p = this.state.players.get(sessionId);
    const m = this.meta.get(sessionId);
    if (!p || !m) return;

    const dropped = this.dropCarried(sessionId, p.x, p.z);
    p.carrying = 0;
    p.deaths++;
    console.log(`[room ${this.roomId}] ${p.name} was caught (dropped ${dropped})`);

    if (this.hasRescuer(sessionId)) {
      p.downed = true;
      p.bleed = BLEED_OUT_SECONDS;
      p.reviveProgress = 0;
      m.reviveFedAt = 0;
      m.ignoreMovesUntil = now + IGNORE_MOVES_MS;
      return;
    }
    this.respawn(sessionId, now);
  }

  /** Back at the spawn point — and the whole crew pays for the walk back. */
  private respawn(sessionId: string, now: number) {
    const p = this.state.players.get(sessionId);
    const m = this.meta.get(sessionId);
    if (!p || !m) return;

    // anything still in hand hits the floor here, not at the spawn
    this.dropCarried(sessionId, p.x, p.z);
    p.carrying = 0;
    p.downed = false;
    p.bleed = 0;
    p.reviveProgress = 0;
    p.crouching = false;
    p.noise = NOISE_IDLE;
    m.invulnUntil = now + RESPAWN_INVULN_MS;
    m.ignoreMovesUntil = now + IGNORE_MOVES_MS;
    p.x = m.spawn.x;
    p.y = 1.05;
    p.z = m.spawn.z;
    m.lastX = m.spawn.x;
    m.lastZ = m.spawn.z;
    m.lastMoveAt = now + IGNORE_MOVES_MS;
    m.moveBudget = 1;
    m.staminaLocked = false;
    // the clock is the real cost of dying
    this.roundEndsAt -= BLEED_TIME_PENALTY * 1000;
    // clear any monster already camping the respawn point (the catcher is
    // scattered separately by the caller; this handles the rest)
    this.clearSpawnArea(m.spawn);

    const client = this.clients.find((c) => c.sessionId === sessionId);
    const death: DeathMessage = { x: m.spawn.x, z: m.spawn.z };
    client?.send(MSG.Death, death);
  }

  // ---------- membership ----------

  onJoin(client: Client, options: { name?: string } = {}) {
    const spawnPoints = this.gen.layout.spawnPoints;
    const idx = this.state.players.size;
    const spawn = spawnPoints[idx % spawnPoints.length];

    const p = new Player();
    p.name =
      String(options.name ?? "").trim().slice(0, MAX_NAME_LENGTH) || "EMPLOYEE";
    p.x = spawn.x;
    p.z = spawn.z;
    p.colorIndex = idx % spawnPoints.length;
    p.cells = this.cellsPerPlayer();

    this.state.players.set(client.sessionId, p);
    this.meta.set(client.sessionId, {
      spawn: { x: spawn.x, z: spawn.z },
      invulnUntil: 0,
      ignoreMovesUntil: 0,
      lastX: spawn.x,
      lastZ: spawn.z,
      lastMoveAt: Date.now(),
      staminaLocked: false,
      moveBudget: 1,
      lastReviveAt: Date.now(),
      reviveFedAt: 0,
    });
    console.log(
      `[room ${this.roomId}] ${p.name} joined (${this.state.players.size}/${this.maxClients})`
    );
    // a crew forming right at round start upgrades the round to multi scale
    if (
      this.state.phase === "active" &&
      this.state.players.size === 2 &&
      this.roundSeconds - this.state.timeLeft < 30
    ) {
      console.log(`[room ${this.roomId}] crew formed — rescaling to multiplayer round`);
      this.resetRound();
    }
  }

  onLeave(client: Client) {
    const p = this.state.players.get(client.sessionId);
    if (p) this.dropCarried(client.sessionId, p.x, p.z);
    this.state.players.delete(client.sessionId);
    this.meta.delete(client.sessionId);
    console.log(`[room ${this.roomId}] ${p?.name ?? client.sessionId} left`);

    // the last person standing can't be revived by a ghost: stand anybody
    // still on the floor back up rather than let them bleed out alone
    if (this.state.phase === "active") {
      const now = Date.now();
      this.state.players.forEach((q, id) => {
        if (q.downed && !this.hasRescuer(id)) this.respawn(id, now);
      });
    }
  }

  onDispose() {
    this.presence.srem(CODE_REGISTRY, this.roomId);
    console.log(`[room ${this.roomId}] disposed`);
  }

  private async generateRoomCode(): Promise<string> {
    for (let attempt = 0; attempt < 32; attempt++) {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      }
      const taken = await this.presence.sismember(CODE_REGISTRY, code);
      if (!taken) {
        await this.presence.sadd(CODE_REGISTRY, code);
        return code;
      }
    }
    throw new Error("failed to generate a unique room code");
  }
}
