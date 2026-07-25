// Escalating shift progression test. Run while the server is up:
//   npm run smoke:shift -w server
//
// Sections, in dependency order (a failure stops everything after it):
//   1. planShift() escalation math (pure, no server)
//   2. shift 1 starts at the solo baseline
//   3. clearing a shift advances AND escalates it (quota up, time down,
//      loot up, and a new monster by shift 3)
//   4. failing a shift repeats it in place (no advance, same difficulty)
//
// The map is pinned (IDENTITY_LAYOUT) and enemies are frozen (noEnemy) so
// wins are driven purely by teleport-banking; enemy *count* still escalates
// because ensureEnemyCount() runs regardless of whether the AI ticks.

import { Client, type Room } from "colyseus.js";
import { ROOM_NAME, MSG } from "../../shared/messages";
import { buildLayout, IDENTITY_LAYOUT } from "../../shared/map";
import { CARRY_CAPACITY, SOLO_MODE, planShift, lootValue } from "../../shared/loot";

const L = buildLayout(IDENTITY_LAYOUT);
const EXTRACT = L.extractionZone;

const ENDPOINT = process.env.ENDPOINT ?? "ws://localhost:2567";
const PARK = { x: -12, z: -6.75 }; // out of every patrol's earshot/sight
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const snap = (room: Room) => (room.state as any).toJSON();
const me = (room: Room) => snap(room).players[room.sessionId];
const enemyCount = (room: Room) => Object.keys(snap(room).enemies).length;
const groundCount = (room: Room) =>
  Object.values(snap(room).loot).filter(
    (l: any) => l.carrier === "" && !l.extracted
  ).length;
/** Total quota value sitting on the floor — what the room clamps quota to. */
const mapValue = (room: Room) =>
  (Object.values(snap(room).loot) as any[]).reduce(
    (sum, l) => sum + lootValue(l.kind),
    0
  );

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

function groundLoot(room: Room): [string, any][] {
  const s = snap(room);
  return Object.entries(s.loot).filter(
    ([, l]: [string, any]) => l.carrier === "" && !l.extracted
  ) as [string, any][];
}

async function pickupOne(room: Room, l: any) {
  sendPos(room, l.x, l.z); // messages are ordered: Move lands before Pickup
  room.send(MSG.Pickup);
  await sleep(180);
}

/** Teleport-bank until the quota is met and the round ends in a win. */
async function winShift(room: Room) {
  const t0 = Date.now();
  while (snap(room).phase === "active" && Date.now() - t0 < 40000) {
    while (me(room).carrying < CARRY_CAPACITY) {
      const ground = groundLoot(room);
      if (!ground.length) break;
      await pickupOne(room, ground[0][1]);
    }
    if (me(room).carrying === 0) break;
    sendPos(room, EXTRACT.x, EXTRACT.z);
    await sleep(250); // extraction banks on the next sim tick
  }
  assert(
    snap(room).phase === "ended" && snap(room).win === true,
    `shift ${snap(room).shift} cleared (banked ${snap(room).extractedTotal}/${snap(room).quota})`
  );
}

/** Assert the live round matches planShift(n) for a solo run. */
function assertPlan(room: Room, shift: number) {
  const plan = planShift(shift, SOLO_MODE, 2);
  const s = snap(room);
  assert(s.shift === shift, `state.shift === ${shift}`);
  // quota is a value target clamped to what the rolled loot is actually worth
  const wantQuota = Math.min(plan.quota, mapValue(room));
  assert(s.quota === wantQuota, `quota === ${wantQuota} (plan, clamped to map value)`);
  assert(
    s.timeLeft >= plan.seconds - 5 && s.timeLeft <= plan.seconds,
    `timer ~${plan.seconds}s (timeLeft=${s.timeLeft})`
  );
  assert(groundCount(room) === plan.loot, `${plan.loot} loot items on the map`);
  assert(enemyCount(room) === plan.enemies, `${plan.enemies} monster(s) present`);
}

async function main() {
  // ---- 1. escalation math (pure) ----
  console.log("[1] planShift escalation math");
  {
    const p1 = planShift(1, SOLO_MODE, 2);
    assert(
      p1.loot === 15 && p1.quota === 24 && p1.seconds === 360 && p1.enemies === 2,
      "shift 1 solo = 15 loot / quota 24 value / 360s / 2 enemies"
    );
    const p2 = planShift(2, SOLO_MODE, 2);
    assert(
      p2.loot === 17 && p2.quota === 29 && p2.seconds === 340 && p2.enemies === 2,
      "shift 2 = 17 / 29 / 340s / 2"
    );
    const p3 = planShift(3, SOLO_MODE, 2);
    assert(
      p3.loot === 19 && p3.quota === 34 && p3.seconds === 320 && p3.enemies === 3,
      "shift 3 adds a third monster"
    );
    const deep = planShift(50, SOLO_MODE, 2);
    assert(
      deep.loot === 26 && deep.seconds === 120 && deep.enemies === 3,
      "deep shift saturates at 26 loot / 120s floor / 3 enemies"
    );
    // planShift no longer clamps quota itself: it is a VALUE target and only
    // the room knows what the rolled loot is actually worth, so the room
    // clamps it to the value on the floor. Section 2 asserts that clamp.
    assert(
      deep.quota > planShift(1, SOLO_MODE, 2).quota,
      "quota keeps climbing with the shift"
    );
  }

  // ---- 2. shift 1 baseline ----
  console.log("[2] shift 1 starts at the solo baseline");
  const room = await new Client(ENDPOINT).create(ROOM_NAME, {
    name: "Runner",
    freeMove: true,
    noEnemy: true,
    layout: IDENTITY_LAYOUT,
  });
  console.log(`room ${room.roomId} created`);
  room.onMessage(MSG.Teleport, () => {}); // round resets teleport us; ignore quietly
  await sleep(300);
  sendPos(room, PARK.x, PARK.z);
  await sleep(150);
  assertPlan(room, 1);

  // ---- 3. clearing a shift advances + escalates it ----
  console.log("[3] win advances and escalates the shift");
  {
    await winShift(room); // clear shift 1
    room.send(MSG.Restart);
    await waitFor(room, "advanced to shift 2", (s) => s.shift === 2 && s.phase === "active", 3000);
    assertPlan(room, 2);
    assert(me(room).extractedCount === 0 && me(room).carrying === 0, "player counters reset");

    await winShift(room); // clear shift 2
    room.send(MSG.Restart);
    await waitFor(room, "advanced to shift 3", (s) => s.shift === 3 && s.phase === "active", 3000);
    assertPlan(room, 3); // asserts the 3rd monster has joined
  }

  await room.leave();

  // ---- 4. failing a shift repeats it in place ----
  console.log("[4] loss repeats the same shift (5s room)");
  {
    const room2 = await new Client(ENDPOINT).create(ROOM_NAME, {
      name: "Idler",
      roundSeconds: 5, // pin a short round for a fast timeout; shift stays unpinned
      freeMove: true,
      noEnemy: true,
      layout: IDENTITY_LAYOUT,
    });
    room2.onMessage(MSG.Teleport, () => {});
    await sleep(200);
    sendPos(room2, PARK.x, PARK.z);
    assert(snap(room2).shift === 1, "starts on shift 1");
    await waitFor(
      room2,
      "round ended in LOSS on timeout",
      (s) => s.phase === "ended" && s.win === false,
      9000
    );
    assert(snap(room2).shift === 1, "shift unchanged by a loss");

    room2.send(MSG.Restart);
    await waitFor(room2, "restarted", (s) => s.phase === "active", 3000);
    assert(snap(room2).shift === 1, "failed shift repeats (still shift 1)");
    assert(
      snap(room2).quota === Math.min(planShift(1, SOLO_MODE, 2).quota, mapValue(room2)),
      "same shift-1 quota on retry"
    );
    assert(enemyCount(room2) === 2, "no extra monster added on a retry");
    await room2.leave();
  }

  console.log("SHIFT SMOKE TEST PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("SHIFT SMOKE TEST FAIL:", err);
  process.exit(1);
});
