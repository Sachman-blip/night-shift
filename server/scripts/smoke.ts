// End-to-end netcode smoke test. Run while the server is up:
//   npm run smoke -w server
// Creates a room as "Host", joins it by code as "Guest", moves the host,
// and asserts the guest sees the host's new position via state sync.

import { Client } from "colyseus.js";
import { ROOM_NAME, MSG } from "../../shared/messages";
import { MAP_BOUNDS } from "../../shared/map";

const ENDPOINT = process.env.ENDPOINT ?? "ws://localhost:2567";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const host = new Client(ENDPOINT);
  const hostRoom = await host.create(ROOM_NAME, { name: "Host", freeMove: true });
  console.log(`host created room, code = ${hostRoom.roomId}`);
  if (!/^[A-Z2-9]{4}$/.test(hostRoom.roomId)) {
    throw new Error(`unexpected room code format: ${hostRoom.roomId}`);
  }

  const guest = new Client(ENDPOINT);
  const guestRoom = await guest.joinById(hostRoom.roomId, { name: "Guest" });
  console.log(`guest joined ${guestRoom.roomId}`);

  // guest joining as 2nd player rescales the round (teleport + brief
  // move-ignore window) — wait it out before sending positions
  await sleep(700);

  hostRoom.send(MSG.Move, {
    x: 3.5, y: 1.05, z: -2, yaw: 1.2, pitch: 0.1, torch: false,
  });
  // out-of-bounds but finite -> server should clamp to MAP_BOUNDS.x (17.7)
  guestRoom.send(MSG.Move, {
    x: 9999, y: -50, z: 0, yaw: 0, pitch: 0, torch: true,
  });
  // NaN payload -> server should reject the whole message
  guestRoom.send(MSG.Move, {
    x: 0, y: 1, z: NaN, yaw: 0, pitch: 0, torch: true,
  });

  await sleep(300); // > patch interval, so the updates have been broadcast

  const seen = (guestRoom.state as any).toJSON();
  console.log("state seen by guest:", JSON.stringify(seen));

  const players = Object.values(seen.players ?? {}) as any[];
  const hostSeen = players.find((p) => p.name === "Host");
  const guestSeen = players.find((p) => p.name === "Guest");

  if (players.length !== 2) throw new Error(`expected 2 players, got ${players.length}`);
  if (!hostSeen || Math.abs(hostSeen.x - 3.5) > 0.001 || hostSeen.torch !== false) {
    throw new Error("host movement did not sync to guest");
  }
  if (!guestSeen || Math.abs(guestSeen.x - MAP_BOUNDS.maxX) > 0.001 || Math.abs(guestSeen.y) > 0.001) {
    throw new Error(`server failed to clamp out-of-bounds position (x=${guestSeen?.x}, y=${guestSeen?.y})`);
  }
  // The NaN message must have been rejected: z still 0 from the clamped message.
  if (!Number.isFinite(guestSeen.z)) throw new Error("NaN leaked into state");

  // default rooms roam TWO monsters with distinct variants, spread apart
  const enemies = Object.values(seen.enemies ?? {}) as any[];
  if (enemies.length !== 2) throw new Error(`expected 2 enemies, got ${enemies.length}`);
  if (enemies[0].variant === enemies[1].variant) {
    throw new Error("enemy variants not distinct");
  }
  const gap = Math.hypot(enemies[0].x - enemies[1].x, enemies[0].z - enemies[1].z);
  if (gap < 8) throw new Error(`enemies spawned too close (${gap.toFixed(1)}m)`);
  console.log(
    `enemies: ${enemies.map((e) => e.variant).join(" + ")}, ${gap.toFixed(1)}m apart`
  );

  console.log("SMOKE TEST PASS");
  await hostRoom.leave();
  await guestRoom.leave();
  process.exit(0);
}

main().catch((err) => {
  console.error("SMOKE TEST FAIL:", err);
  process.exit(1);
});
