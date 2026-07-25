// Between-shift map RE-ROLL test. Run while the server is up:
//   npm run smoke:reroll -w server
//
// Every other smoke script pins the arrangement (IDENTITY_LAYOUT) so its
// coordinates stay deterministic — which also switches the re-roll OFF, since
// resetRound() only re-rolls when no layout was pinned. This script is the
// one that deliberately leaves it unpinned, so the path a real crew hits when
// they restart a shift actually gets exercised.
//
// Sections, in dependency order (a failure stops everything after it):
//   1. restarting re-rolls the building, and every part of room state that
//      describes the map is rebuilt to match the NEW arrangement
//   2. a monster dropped into a re-rolled map navigates it for real: it keeps
//      moving, and it never ends up inside one of the new walls
//
// Section 2 is the point of the whole file. The AIs are constructed once and
// re-pointed at the new nav/sight systems by setWorld(); if that were missed,
// a monster would keep walking the OLD floor plan and clip through the new
// geometry, which is exactly what the wall check below catches.

import { Client, type Room } from "colyseus.js";
import { ROOM_NAME, MSG } from "../../shared/messages";
import {
  buildLayout,
  MAP_BOUNDS,
  type BoxDef,
  type Layout,
  type LayoutDescriptor,
} from "../../shared/map";
import { lootValue } from "../../shared/loot";

const ENDPOINT = process.env.ENDPOINT ?? "ws://localhost:2567";
/** Short rounds: a loss on the clock is the cheapest way to reach a restart. */
const ROUND_SECONDS = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const snap = (room: Room) => (room.state as any).toJSON();
const me = (room: Room) => snap(room).players[room.sessionId];
/** Body height, where a wall either blocks you or does not. */
const BODY_Y = 1.05;

function assert(cond: unknown, label: string) {
  if (!cond) throw new Error(`assert failed: ${label}`);
  console.log(`  ok: ${label}`);
}

async function waitFor(
  room: Room,
  label: string,
  pred: (s: any) => boolean,
  timeoutMs: number
) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred(snap(room))) {
      console.log(`  ok: ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return;
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function sendPos(room: Room, x: number, z: number) {
  room.send(MSG.Move, {
    x, y: BODY_Y, z, yaw: 0, pitch: 0, torch: false, crouch: false,
  });
}

/** The layout the room says it is currently running. */
function currentLayout(room: Room): { desc: LayoutDescriptor; L: Layout } {
  const desc = JSON.parse(snap(room).layout) as LayoutDescriptor;
  return { desc, L: buildLayout(desc) };
}

/** Solid walls that exist at body height — deco boxes have no collider. */
function wallsAtBodyHeight(L: Layout): BoxDef[] {
  return L.boxes.filter(
    (b) => !b.deco && b.y - b.sy / 2 <= BODY_Y && b.y + b.sy / 2 >= BODY_Y
  );
}

/**
 * Is (x, z) buried inside a wall? Uses an inward margin so merely grazing a
 * surface — which the collision-free AI does legitimately, since it steps to
 * points ON the nav graph — is not reported.
 */
function insideWall(x: number, z: number, walls: BoxDef[], margin = 0.2): BoxDef | null {
  for (const b of walls) {
    if (
      x > b.x - b.sx / 2 + margin && x < b.x + b.sx / 2 - margin &&
      z > b.z - b.sz / 2 + margin && z < b.z + b.sz / 2 - margin
    ) {
      return b;
    }
  }
  return null;
}

/** Time out the round, then restart it — which is what triggers the re-roll. */
async function restartRound(room: Room) {
  await waitFor(room, "round ended on the clock", (s) => s.phase === "ended", 12000);
  await restartFromEnded(room);
}

async function restartFromEnded(room: Room) {
  room.send(MSG.Restart);
  await waitFor(room, "next round active", (s) => s.phase === "active", 5000);
  await sleep(450); // resetRound ignores moves briefly after teleporting
}

/**
 * Clear the round outright by banking a single item (the caller pins quota to
 * 1). Section 2 needs a LONG round to watch a patrol in, so it cannot reach a
 * restart by running the clock down the way section 1 does.
 */
async function winRound(room: Room) {
  const zone = currentLayout(room).L.extractionZone;
  const ground = (Object.values(snap(room).loot) as any[]).find(
    (l) => l.carrier === "" && !l.extracted
  );
  if (!ground) throw new Error("no ground loot to bank");

  sendPos(room, ground.x, ground.z); // messages are ordered: Move lands first
  room.send(MSG.Pickup);
  await waitFor(room, "banked an item to clear the round",
    (s) => s.players[room.sessionId]?.carrying === 1, 2000);
  sendPos(room, zone.x, zone.z);
  await waitFor(room, "round cleared", (s) => s.phase === "ended", 4000);
  await restartFromEnded(room);
}

async function main() {
  // ---- 1. the building is re-rolled, and room state follows it ----
  console.log("[1] restarting re-rolls the map and rebuilds the state around it");
  {
    const room = await new Client(ENDPOINT).create(ROOM_NAME, {
      name: "Roller", noEnemy: true, roundSeconds: ROUND_SECONDS,
      variant: "stalker", enemies: 1,
    });
    await sleep(300);

    const seen = new Set<string>();
    seen.add(snap(room).layout);
    const enemyIds = Object.keys(snap(room).enemies).sort().join(",");
    const ROUNDS = 6;

    for (let r = 1; r <= ROUNDS; r++) {
      await restartRound(room);
      const s = snap(room);
      const { L } = currentLayout(room);
      seen.add(s.layout);

      // players sit on a spawn point of the layout that is live RIGHT NOW
      const self = me(room);
      const onSpawn = L.spawnPoints.some(
        (p) => Math.hypot(p.x - self.x, p.z - self.z) < 0.5
      );
      if (!onSpawn) {
        throw new Error(
          `round ${r}: player at (${self.x.toFixed(1)}, ${self.z.toFixed(1)}) ` +
          `is not on any new spawn point ` +
          `[${L.spawnPoints.map((p) => `(${p.x},${p.z})`).join(" ")}]`
        );
      }

      // Every item on the floor has to be a candidate of the NEW layout.
      // Loot carried over from the previous arrangement would land inside a
      // wall or out in the void, and this is what would catch it.
      const candidates = L.lootCandidates;
      for (const [id, l] of Object.entries(s.loot) as [string, any][]) {
        const match = candidates.find(
          (c) => Math.abs(c.x - l.x) < 0.01 && Math.abs(c.z - l.z) < 0.01
        );
        if (!match) {
          throw new Error(
            `round ${r}: loot ${id} (${l.kind}) at (${l.x}, ${l.z}) is not a ` +
            `spawn candidate of the current layout`
          );
        }
        if (match.kind !== l.kind) {
          throw new Error(
            `round ${r}: loot ${id} at (${l.x}, ${l.z}) is a ${l.kind} but the ` +
            `candidate there is a ${match.kind}`
          );
        }
      }

      // the round has to remain winnable on the new floor plan
      const value = (Object.values(s.loot) as any[]).reduce(
        (sum, l) => sum + lootValue(l.kind),
        0
      );
      if (s.quota > value) {
        throw new Error(`round ${r}: quota ${s.quota} exceeds map value ${value}`);
      }

      // gates re-lock, so the keycard detour is a fresh decision every shift
      if (s.keycardTaken || s.archivesUnlocked || s.shortcutOpen) {
        throw new Error(`round ${r}: a gate carried over unlocked`);
      }
    }

    assert(seen.size >= ROUNDS, `${seen.size} distinct arrangements over ${ROUNDS} restarts`);
    assert(
      Object.keys(snap(room).enemies).sort().join(",") === enemyIds,
      "enemy ids survive the re-roll (client views stay valid)"
    );
    console.log("  ok: spawns, loot, quota and gates all matched each new map");
    await room.leave();
  }

  // ---- 2. the AI navigates the map it is actually in ----
  console.log("[2] a monster in a re-rolled map keeps moving and stays out of walls");
  {
    // No roundSeconds: the round has to outlast the observation window, so
    // restarts are reached by clearing a pinned quota of 1 instead.
    const room = await new Client(ENDPOINT).create(ROOM_NAME, {
      name: "Watcher", freeMove: true, quota: 1, variant: "stalker", enemies: 1,
    });
    await sleep(300);

    // Re-roll twice, so the AI is running on a world it was NOT constructed
    // with — the setWorld() path rather than the constructor path.
    await winRound(room);
    await winRound(room);

    const { L } = currentLayout(room);
    const walls = wallsAtBodyHeight(L);
    assert(walls.length > 0, `new layout has ${walls.length} solid walls at body height`);

    // Sit still in a corner of the extraction zone: we are only watching.
    sendPos(room, L.extractionZone.x, L.extractionZone.z);

    const start = snap(room).enemies.e0;
    let travelled = 0;
    let prev = { x: start.x, z: start.z };
    let maxStep = 0;
    let scatters = 0;
    let deaths = me(room).deaths;
    let buried: { x: number; z: number; box: BoxDef } | null = null;
    const samples = 120; // ~24s at 200ms

    for (let i = 0; i < samples; i++) {
      await sleep(200);
      const s = snap(room);
      if (s.phase !== "active") break; // round ended under us; that is fine
      const e = s.enemies.e0;

      if (e.x < MAP_BOUNDS.minX || e.x > MAP_BOUNDS.maxX ||
          e.z < MAP_BOUNDS.minZ || e.z > MAP_BOUNDS.maxZ) {
        throw new Error(`monster left the building at (${e.x.toFixed(1)}, ${e.z.toFixed(1)})`);
      }

      const box = insideWall(e.x, e.z, walls);
      if (box && !buried) buried = { x: e.x, z: e.z, box };

      // Catching somebody scatters the monster to a far patrol node on
      // purpose. That is a teleport, so it breaks the continuity measurement
      // rather than the map: skip the step instead of counting it.
      const nowDeaths = s.players[room.sessionId]?.deaths ?? deaths;
      if (nowDeaths !== deaths) {
        deaths = nowDeaths;
        scatters++;
        prev = { x: e.x, z: e.z };
        continue;
      }

      const step = Math.hypot(e.x - prev.x, e.z - prev.z);
      travelled += step;
      maxStep = Math.max(maxStep, step);
      prev = { x: e.x, z: e.z };
    }
    if (scatters) console.log(`  info: ignored ${scatters} scatter teleport(s) after a catch`);

    if (buried) {
      const b = buried.box;
      throw new Error(
        `monster stood inside a wall of the CURRENT layout at ` +
        `(${buried.x.toFixed(2)}, ${buried.z.toFixed(2)}) — box centred ` +
        `(${b.x}, ${b.z}) size ${b.sx}x${b.sz}. A stale nav/sight system from ` +
        `the previous arrangement is the usual cause.`
      );
    }
    assert(true, "monster never entered a wall of the re-rolled map");
    assert(
      travelled > 12,
      `monster patrolled the new map (${travelled.toFixed(1)}m travelled)`
    );
    // A teleport-sized jump would mean it was re-seated rather than walking.
    assert(maxStep < 3, `movement stayed continuous (largest step ${maxStep.toFixed(2)}m)`);
    await room.leave();
  }

  console.log("REROLL SMOKE TEST PASS");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("REROLL SMOKE TEST FAIL:", e);
    process.exit(1);
  });
