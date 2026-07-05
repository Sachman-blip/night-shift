// Stamina enforcement test. Run while the server is up:
//   npm run smoke:stamina -w server
//
// A client CLAIMS continuous sprint-speed movement for 8s. Honest max
// distance = ~5.5s sprint (31.9m) + ~2.5s forced walk (8.5m) ≈ 40.4m.
// The full claim would be 46.4m — the server must clamp the difference,
// and the synced stamina value must drain to ~0 then regen while idle.

import { Client, type Room } from "colyseus.js";
import { ROOM_NAME, MSG, SPRINT_SPEED, WALK_SPEED } from "../../shared/messages";

const ENDPOINT = process.env.ENDPOINT ?? "ws://localhost:2567";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const snap = (room: Room) => (room.state as any).toJSON();
const me = (room: Room) => snap(room).players[room.sessionId];

function assert(cond: unknown, label: string) {
  if (!cond) throw new Error(`assert failed: ${label}`);
  console.log(`  ok: ${label}`);
}

async function main() {
  const room = await new Client(ENDPOINT).create(ROOM_NAME, {
    name: "Sprinter", noEnemy: true,
  });
  await sleep(400);

  const start = me(room);
  const dir = start.x > 10 ? -1 : 1; // run along the corridor, away from walls
  console.log(`spawn at x=${start.x.toFixed(1)}, running ${dir > 0 ? "+x" : "-x"}`);

  // claim sprint speed for 8 seconds straight (position from wall clock,
  // so the claimed speed is exactly SPRINT_SPEED regardless of loop jitter)
  const SECONDS = 8;
  let claimedX = start.x;
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    const elapsed = (Date.now() - t0) / 1000;
    claimedX = start.x + dir * SPRINT_SPEED * elapsed;
    room.send(MSG.Move, {
      x: claimedX, y: 1.05, z: start.z, yaw: 0, pitch: 0, torch: false,
    });
    await sleep(50);
  }
  await sleep(200);

  const after = me(room);
  const traveled = Math.abs(after.x - start.x);
  const claimed = Math.abs(claimedX - start.x);
  const honestMax = 5.5 * SPRINT_SPEED + (SECONDS - 5.5) * WALK_SPEED;
  console.log(
    `claimed ${claimed.toFixed(1)}m, server allowed ${traveled.toFixed(1)}m ` +
    `(honest max ~${honestMax.toFixed(1)}m)`
  );
  assert(traveled < claimed - 2, "server clamped the sprint claim");
  assert(traveled <= honestMax * 1.15, "allowed distance within honest sprint+walk budget");
  assert(after.stamina < 0.15, `stamina drained (${after.stamina.toFixed(2)})`);

  // regen while idle: keep sending the same position (zero speed)
  const t1 = Date.now();
  while (Date.now() - t1 < 4200) {
    room.send(MSG.Move, {
      x: after.x, y: 1.05, z: after.z, yaw: 0, pitch: 0, torch: false,
    });
    await sleep(100);
  }
  await sleep(200);
  const rested = me(room);
  assert(rested.stamina > 0.95, `stamina regenerated while idle (${rested.stamina.toFixed(2)})`);

  console.log("STAMINA SMOKE TEST PASS");
  await room.leave();
  process.exit(0);
}

main().catch((err) => {
  console.error("STAMINA SMOKE TEST FAIL:", err);
  process.exit(1);
});
