// Loot + extraction round test. Run while the server is up:
//   npm run smoke:round -w server
//
// Sections, in dependency order (a failure stops everything after it):
//   1. loot spawns, pickup, carry capacity enforced
//   2. death drops carried loot at the death spot
//   3. extraction zone banks loot -> quota win
//   4. restart resets the round
//   5. timer expiry -> loss (separate short-round room)
//
// The test avoids nondeterministic enemy contact by always teleporting to
// loot that is currently far (>9m) from the enemy â€” outside hearing (4m)
// and gone again within ~200ms, before any approach matters.

import { Client, type Room } from "colyseus.js";
import {
  ROOM_NAME,
  MSG,
  type DeathMessage,
  type TeleportMessage,
} from "../../shared/messages";
import { buildLayout, IDENTITY_LAYOUT, LOOT_COUNT } from "../../shared/map";
import { CARRY_CAPACITY, lootValue } from "../../shared/loot";

const L = buildLayout(IDENTITY_LAYOUT);
const SPAWN_POINTS = L.spawnPoints;
const EXTRACTION_ZONE = L.extractionZone;

const ENDPOINT = process.env.ENDPOINT ?? "ws://localhost:2567";
const PARK = { x: -12, z: -6.75 }; // room A: patrol can't hear or see it
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const snap = (room: Room) => (room.state as any).toJSON();
const me = (room: Room) => snap(room).players[room.sessionId];

function sendPos(room: Room, x: number, z: number) {
  room.send(MSG.Move, { x, y: 1.05, z, yaw: 0, pitch: 0, torch: false });
}

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

/** Ground loot entries [id, loot], farthest-first from the enemy's live position. */
function groundLootByDistance(room: Room): [string, any][] {
  const s = snap(room);
  return Object.entries(s.loot)
    .filter(([, l]: [string, any]) => l.carrier === "" && !l.extracted)
    .sort(([, a]: [string, any], [, b]: [string, any]) => {
      const da = Math.hypot(a.x - s.enemies.e0.x, a.z - s.enemies.e0.z);
      const db = Math.hypot(b.x - s.enemies.e0.x, b.z - s.enemies.e0.z);
      return db - da;
    }) as [string, any][];
}

async function pickupOne(room: Room, id: string, l: any) {
  sendPos(room, l.x, l.z); // messages are ordered: Move lands before Pickup
  room.send(MSG.Pickup);
  await sleep(200); // sim tick + patch
}

async function main() {
  const client = new Client(ENDPOINT);
  const room = await client.create(ROOM_NAME, {
    name: "Runner",
    quota: 2,
    roundSeconds: 120,
    freeMove: true,
    layout: IDENTITY_LAYOUT, variant: "stalker", enemies: 1,
  });
  console.log(`room ${room.roomId} created (quota 2, 120s)`);

  let death: DeathMessage | null = null;
  let teleport: TeleportMessage | null = null;
  room.onMessage(MSG.Death, (m: DeathMessage) => (death = m));
  room.onMessage(MSG.Teleport, (m: TeleportMessage) => (teleport = m));

  await sleep(300);
  sendPos(room, PARK.x, PARK.z);
  await sleep(150);

  // ---- 1. spawns + pickup + capacity ----
  console.log("[1] loot & carry capacity");
  {
    const s = snap(room);
    assert(s.quota === 2, "room options applied (quota=2)");
    assert(
      s.timeLeft > 110 && s.timeLeft <= 120,
      `timer running from 120 (timeLeft=${s.timeLeft})`
    );
    const t1 = s.timeLeft;
    await sleep(2100);
    const t2 = snap(room).timeLeft;
    assert(
      t2 <= t1 - 2 && t2 >= t1 - 4,
      `timer counts down in synced state (${t1} -> ${t2} after 2.1s)`
    );
    const ids = Object.keys(s.loot);
    assert(
      ids.length === LOOT_COUNT,
      `${LOOT_COUNT} loot items spawned`
    );

    for (let i = 0; i < CARRY_CAPACITY; i++) {
      const [id, l] = groundLootByDistance(room)[0];
      await pickupOne(room, id, l);
      const m = me(room);
      assert(m.carrying === i + 1, `picked up item ${i + 1} (carrying=${m.carrying})`);
      assert(snap(room).loot[id].carrier === room.sessionId, `item ${id} marked carried by me`);
    }

    // over capacity: nothing should change
    const [id4, l4] = groundLootByDistance(room)[0];
    await pickupOne(room, id4, l4);
    assert(me(room).carrying === CARRY_CAPACITY, "4th pickup rejected at capacity");
    assert(snap(room).loot[id4].carrier === "", "4th item still on the ground");
  }

  // ---- 2. death drops loot ----
  console.log("[2] death drops carried loot");
  {
    let lastStand = { x: 0, z: 0 };
    const t0 = Date.now();
    while (!death && Date.now() - t0 < 6000) {
      const e = snap(room).enemies.e0;
      lastStand = { x: e.x, z: e.z };
      sendPos(room, e.x, e.z);
      await sleep(100);
    }
    assert(death, "death message received");
    // wait out the post-death move-ignore window (300ms) plus a patch,
    // otherwise section 3's first teleport-to-loot is silently dropped
    await sleep(500);

    const s = snap(room);
    const m = me(room);
    assert(m.carrying === 0, "carrying reset to 0 on death");
    assert(m.deaths === 1, "death counted");
    const spawn = SPAWN_POINTS[0];
    assert(
      Math.abs(m.x - spawn.x) < 0.01 && Math.abs(m.z - spawn.z) < 0.01,
      "respawned at spawn"
    );
    const dropped = Object.values(s.loot).filter(
      (l: any) =>
        l.carrier === "" &&
        !l.extracted &&
        Math.hypot(l.x - lastStand.x, l.z - lastStand.z) < 3
    );
    assert(
      dropped.length >= CARRY_CAPACITY,
      `all ${CARRY_CAPACITY} carried items dropped near death spot (found ${dropped.length})`
    );
  }

  // ---- 3. extraction -> win ----
  console.log("[3] extraction banks loot and wins at quota");
  {
    // Quota is a VALUE target now, so the win depends on WHAT was grabbed:
    // sum the two items' worth and expect exactly that much banked.
    let expectedValue = 0;
    for (let i = 0; i < 2; i++) {
      const [id, l] = groundLootByDistance(room)[0];
      expectedValue += lootValue(l.kind);
      await pickupOne(room, id, l);
    }
    assert(me(room).carrying === 2, "carrying 2 for extraction");

    sendPos(room, EXTRACTION_ZONE.x, EXTRACTION_ZONE.z);
    await waitFor(room, "round ended in WIN", (s) => s.phase === "ended" && s.win === true, 3000);

    const s = snap(room);
    const m = me(room);
    assert(m.extractedCount === 2, "extractedCount = 2 for me");
    assert(m.carrying === 0, "carrying emptied by banking");
    assert(
      s.extractedTotal === expectedValue,
      `team banked the two items' value (${s.extractedTotal} === ${expectedValue})`
    );
    assert(
      m.extractedValue === expectedValue,
      `my extractedValue === ${expectedValue}`
    );
    assert(s.credits > 0, `clearing the shift paid credits (${s.credits})`);

    // enemy must be frozen during results
    const e1 = s.enemies.e0;
    await sleep(700);
    const e2 = snap(room).enemies.e0;
    assert(
      Math.hypot(e2.x - e1.x, e2.z - e1.z) < 0.01,
      "enemy frozen while round is ended"
    );
  }

  // ---- 4. restart resets the round ----
  console.log("[4] restart");
  {
    teleport = null;
    room.send(MSG.Restart);
    await sleep(500);

    const s = snap(room);
    const m = me(room);
    assert(s.phase === "active" && s.win === false, "phase back to active");
    assert(s.timeLeft > 110, `timer reset (timeLeft=${s.timeLeft})`);
    assert(s.extractedTotal === 0, "extractedTotal reset");
    // this restart follows a WIN, so shift progression advances to shift 2:
    // more loot spawns than the shift-1 baseline, all of it back on the ground.
    assert(s.shift === 2, "winning restart advanced to shift 2");
    const ground = Object.values(s.loot).filter(
      (l: any) => l.carrier === "" && !l.extracted
    );
    const totalLoot = Object.keys(s.loot).length;
    assert(
      ground.length === totalLoot && totalLoot >= LOOT_COUNT,
      `all ${totalLoot} loot items respawned on the ground (none carried/extracted)`
    );
    assert(
      m.carrying === 0 && m.extractedCount === 0 && m.deaths === 0,
      "player counters reset"
    );
    assert(teleport, "teleport message received");
    const spawn = SPAWN_POINTS[0];
    assert(
      Math.abs(m.x - spawn.x) < 0.01 && Math.abs(m.z - spawn.z) < 0.01,
      "player back at spawn"
    );
  }

  await room.leave();

  // ---- 5. timeout -> loss ----
  console.log("[5] timeout loss (separate 5s room)");
  {
    const room2 = await new Client(ENDPOINT).create(ROOM_NAME, {
      name: "Idler",
      roundSeconds: 5,
      freeMove: true,
    });
    sendPos(room2, PARK.x, PARK.z);
    await waitFor(
      room2,
      "round ended in LOSS on timeout",
      (s) => s.phase === "ended" && s.win === false,
      9000
    );
    await room2.leave();
  }

  console.log("ROUND SMOKE TEST PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("ROUND SMOKE TEST FAIL:", err);
  process.exit(1);
});



