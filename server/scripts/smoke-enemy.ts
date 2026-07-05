// Enemy AI end-to-end test. Run while the server is up:
//   npm run smoke:enemy -w server
//
// A "Bait" client walks the enemy through its whole state machine:
//   patrol (moving) -> chase (bait placed nearby) -> search (bait vanishes)
//   -> patrol -> contact kill -> death message + respawn at spawn point.
//
// PARK is room A's center: the patrol route never enters the map's west
// side, and the x=-6 divider wall blocks line of sight from the lobby, so
// a player parked there is deterministically undetectable.

import { Client, type Room } from "colyseus.js";
import { ROOM_NAME, MSG, type DeathMessage } from "../../shared/messages";
import { buildLayout, IDENTITY_LAYOUT } from "../../shared/map";

const SPAWN_POINTS = buildLayout(IDENTITY_LAYOUT).spawnPoints;

const ENDPOINT = process.env.ENDPOINT ?? "ws://localhost:2567";
const PARK = { x: -12, z: -6.75 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const snap = (room: Room) => (room.state as any).toJSON();
const enemyOf = (room: Room) => snap(room).enemies.e0;

function sendPos(room: Room, x: number, z: number) {
  room.send(MSG.Move, { x, y: 1.05, z, yaw: 0, pitch: 0, torch: false });
}

async function waitFor(
  room: Room,
  label: string,
  pred: (s: any) => boolean,
  timeoutMs: number
) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = snap(room);
    if (pred(s)) {
      console.log(`  ok: ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return s;
    }
    await sleep(50);
  }
  throw new Error(
    `timeout waiting for ${label}; enemy = ${JSON.stringify(enemyOf(room))}`
  );
}

async function main() {
  const client = new Client(ENDPOINT);
  const room = await client.create(ROOM_NAME, {
    name: "Bait", freeMove: true, layout: IDENTITY_LAYOUT, variant: "stalker", enemies: 1,
  });
  console.log(`room ${room.roomId} created`);

  let death: DeathMessage | null = null;
  room.onMessage(MSG.Death, (m: DeathMessage) => (death = m));

  await sleep(300); // initial state
  sendPos(room, PARK.x, PARK.z);

  // 1. patrol, and actually moving (position broadcast works)
  await waitFor(room, "enemy in patrol state", (s) => s.enemies.e0?.aiState === "patrol", 3000);
  const e1 = enemyOf(room);
  await sleep(1200);
  const e2 = enemyOf(room);
  const moved = Math.hypot(e2.x - e1.x, e2.z - e1.z);
  if (moved < 0.5) throw new Error(`enemy not patrolling: moved ${moved.toFixed(2)}m in 1.2s`);
  console.log(`  ok: enemy patrols (moved ${moved.toFixed(1)}m in 1.2s)`);

  // 2. patrol -> chase: bait inside hearing radius, outside kill radius
  const e3 = enemyOf(room);
  sendPos(room, e3.x + 3.5, e3.z);
  await waitFor(room, "patrol -> chase", (s) => s.enemies.e0.aiState === "chase", 3000);

  // 3. chase -> search -> patrol: bait vanishes to the safe room
  sendPos(room, PARK.x, PARK.z);
  await waitFor(room, "chase -> search", (s) => s.enemies.e0.aiState === "search", 10000);
  await waitFor(room, "search -> patrol", (s) => s.enemies.e0.aiState === "patrol", 15000);

  // 4. contact kill: sit on the enemy until it touches us
  const t0 = Date.now();
  let killSite = { x: 0, z: 0 };
  while (!death && Date.now() - t0 < 5000) {
    const e = enemyOf(room);
    killSite = { x: e.x, z: e.z };
    sendPos(room, e.x, e.z);
    await sleep(100);
  }
  if (!death) throw new Error("no death message after 5s of standing on the enemy");
  await sleep(200);
  const scattered = enemyOf(room);
  const scatterDist = Math.hypot(scattered.x - killSite.x, scattered.z - killSite.z);
  if (scatterDist < 10) {
    throw new Error(`enemy did not scatter after kill (moved ${scatterDist.toFixed(1)}m)`);
  }
  console.log(`  ok: catcher scattered ${scatterDist.toFixed(1)}m away from the kill site`);
  const d: DeathMessage = death;
  console.log(`  ok: contact kill (death message x=${d.x}, z=${d.z})`);

  // 5. respawn: death message points at our spawn, and state agrees
  const spawn = SPAWN_POINTS[0]; // first joiner
  if (Math.abs(d.x - spawn.x) > 0.01 || Math.abs(d.z - spawn.z) > 0.01) {
    throw new Error(`death message not at spawn: got (${d.x}, ${d.z})`);
  }
  await sleep(400); // move-ignore window is 300ms; let a patch arrive
  const me = Object.values(snap(room).players).find((p: any) => p.name === "Bait") as any;
  if (!me || Math.abs(me.x - spawn.x) > 0.01 || Math.abs(me.z - spawn.z) > 0.01) {
    throw new Error(`player not respawned at spawn in state: (${me?.x}, ${me?.z})`);
  }
  console.log("  ok: respawned at spawn point");

  // 6. enemy resumes patrol after the kill
  await waitFor(room, "post-kill patrol", (s) => s.enemies.e0.aiState === "patrol", 3000);

  console.log("ENEMY SMOKE TEST PASS");
  await room.leave();
  process.exit(0);
}

main().catch((err) => {
  console.error("ENEMY SMOKE TEST FAIL:", err);
  process.exit(1);
});


