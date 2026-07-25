// Map/gates/patrol/pacing test over the PINNED identity layout (so all
// coordinates are deterministic). Run while the server is up:
//   npm run smoke:map -w server
// Random-arrangement constraints are covered separately by smoke-assembly.

import { Client, type Room } from "colyseus.js";
import { ROOM_NAME, MSG } from "../../shared/messages";
import { buildLayout, IDENTITY_LAYOUT, LOOT_COUNT } from "../../shared/map";
import { CARRY_CAPACITY, ROUND_SECONDS } from "../../shared/loot";
import { createLos } from "../src/ai/los";
import { createNav } from "../src/ai/nav";

const ENDPOINT = process.env.ENDPOINT ?? "ws://localhost:2567";
const PARK = { x: -12, z: -6.75 }; // slot n0: never on the patrol route
// Walk pace (below the sprint-detect threshold): with stamina-limited
// sprint the honest sustained speed is walking, so this is the
// conservative "no sprint management at all" pacing bound.
const BOT_SPEED = 3.3;
/** Value quota for the pacing bot — about seven average items' worth. */
const PACE_QUOTA = 18;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const L = buildLayout(IDENTITY_LAYOUT);
const los = createLos(L.boxes, L.gateDoors);
const nav = createNav(L.navNodes, L.navEdges, los);

const snap = (room: Room) => (room.state as any).toJSON();
const me = (room: Room) => snap(room).players[room.sessionId];

function sendPos(room: Room, x: number, z: number) {
  room.send(MSG.Move, {
    x, y: 1.05, z, yaw: 0, pitch: 0, torch: false, crouch: false,
  });
}

function assert(cond: unknown, label: string) {
  if (!cond) throw new Error(`assert failed: ${label}`);
  console.log(`  ok: ${label}`);
}

/**
 * Poll a fresh snapshot until `pred` holds. State arrives in patches every
 * PATCH_RATE_MS, so anything that waits a fixed number of milliseconds and
 * then reads is racing the network — wait for the state itself instead.
 */
async function waitFor(pred: () => boolean, ms = 2000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}

async function main() {
  // ---- 1. loot spread in a live room ----
  console.log("[1] loot spread (live room, pinned layout)");
  {
    const room = await new Client(ENDPOINT).create(ROOM_NAME, {
      name: "Surveyor", noEnemy: true, layout: IDENTITY_LAYOUT, variant: "stalker", enemies: 1,
    });
    await sleep(300);
    const items = Object.values(snap(room).loot) as any[];
    assert(items.length === LOOT_COUNT, `${LOOT_COUNT} loot items spawned`);
    let minPair = Infinity;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        minPair = Math.min(
          minPair,
          Math.hypot(items[i].x - items[j].x, items[i].z - items[j].z)
        );
      }
    }
    assert(minPair >= 4.5, `no cluster: closest pair ${minPair.toFixed(1)}m apart`);
    const xs = items.map((s) => s.x);
    const zs = items.map((s) => s.z);
    assert(Math.max(...xs) - Math.min(...xs) >= 40, `x coverage ${(Math.max(...xs) - Math.min(...xs)).toFixed(1)}m`);
    assert(Math.max(...zs) - Math.min(...zs) >= 20, `z coverage ${(Math.max(...zs) - Math.min(...zs)).toFixed(1)}m`);
    const east = items.filter((s) => s.x > 18).length;
    assert(east >= 5, `east wing has ${east}/${LOOT_COUNT} items`);
    await room.leave();
  }

  // ---- 2. gates ----
  console.log("[2] keycard & breaker gates");
  {
    const room = await new Client(ENDPOINT).create(ROOM_NAME, {
      name: "Gates", noEnemy: true, freeMove: true, layout: IDENTITY_LAYOUT, variant: "stalker", enemies: 1,
    });
    await sleep(300);
    assert(snap(room).keycardTaken === false, "keycard present at round start");

    sendPos(room, L.keycardPos.x, L.keycardPos.z);
    room.send(MSG.Pickup);
    await waitFor(() => snap(room).keycardTaken === true);
    let s = snap(room);
    assert(s.keycardTaken === true, "keycard taken");
    assert(s.archivesUnlocked === true, "archives unlocked by keycard");
    assert(me(room).carrying === 0, "keycard does not use carry capacity");

    sendPos(room, L.breakerPos.x, L.breakerPos.z);
    room.send(MSG.Pickup);
    await waitFor(() => snap(room).shortcutOpen === true);
    assert(snap(room).shortcutOpen === true, "breaker opens the shutter");

    // archive loot exists and is grabbable once inside
    const locked = L.lootCandidates.find((c) => c.locked)!;
    sendPos(room, locked.x, locked.z);
    room.send(MSG.Pickup);
    await waitFor(() => me(room).carrying === 1);
    assert(me(room).carrying === 1, "archive loot pickup works");
    await room.leave();
  }

  // ---- 3. patrol coverage ----
  console.log("[3] enemy patrol covers the east wing (watching ~90s)");
  {
    const room = await new Client(ENDPOINT).create(ROOM_NAME, {
      name: "Watcher", freeMove: true, layout: IDENTITY_LAYOUT, variant: "stalker", enemies: 1,
    });
    await sleep(300);
    sendPos(room, PARK.x, PARK.z);

    let reachedDeepEast = false;
    let maxX = -Infinity;
    const history: { t: number; x: number; z: number }[] = [];
    const t0 = Date.now();

    while (Date.now() - t0 < 95000) {
      const e = snap(room).enemies.e0;
      const t = Date.now() - t0;
      history.push({ t, x: e.x, z: e.z });
      maxX = Math.max(maxX, e.x);
      if (e.x > 30) {
        reachedDeepEast = true;
        break;
      }
      const old = history.find((h) => t - h.t >= 6000 && t - h.t < 6300);
      if (old && Math.hypot(e.x - old.x, e.z - old.z) < 1.5) {
        throw new Error(`enemy stalled near (${e.x.toFixed(1)}, ${e.z.toFixed(1)}) at t=${(t / 1000).toFixed(0)}s`);
      }
      await sleep(250);
    }
    assert(reachedDeepEast, `enemy reached deep east wing (max x=${maxX.toFixed(1)}) without stalling`);
    await room.leave();
  }

  // ---- 4. paced full round ----
  console.log("[4] paced completability bot (walk-speed, nav-graph walking)");
  {
    const room = await new Client(ENDPOINT).create(ROOM_NAME, {
      name: "Pacer", noEnemy: true, quota: PACE_QUOTA, roundSeconds: ROUND_SECONDS,
      layout: IDENTITY_LAYOUT, variant: "stalker", enemies: 1,
    });
    await sleep(300);
    const startedAt = Date.now();
    let pos = { ...L.spawnPoints[0] };

    async function walkTo(tx: number, tz: number) {
      const ids = nav.findPath(
        nav.nearestVisibleNode(pos.x, pos.z),
        nav.nearestVisibleNode(tx, tz),
        () => false
      );
      const waypoints = ids
        .map((id: string) => nav.nodes[id])
        .concat([{ x: tx, z: tz }]);
      for (const wp of waypoints) {
        while (true) {
          const dx = wp.x - pos.x;
          const dz = wp.z - pos.z;
          const d = Math.hypot(dx, dz);
          const step = BOT_SPEED * 0.05;
          if (d <= step) {
            pos = { x: wp.x, z: wp.z };
            sendPos(room, pos.x, pos.z);
            break;
          }
          pos = { x: pos.x + (dx / d) * step, z: pos.z + (dz / d) * step };
          sendPos(room, pos.x, pos.z);
          await sleep(50);
        }
      }
    }

    /**
     * Walk to an item and take it. Success is "that specific item is in MY
     * hands", read from state — not "my carry count went up by one after a
     * sleep". Keying on the item makes the retry harmless: if the first
     * pickup already landed, or a retry grabs a neighbour as well, neither
     * turns into a spurious failure.
     */
    async function grab(id: string, x: number, z: number) {
      await walkTo(x, z);
      const held = () =>
        (snap(room).loot as Record<string, any>)[id]?.carrier === room.sessionId;
      for (const attempt of [0, 1]) {
        room.send(MSG.Pickup);
        if (await waitFor(held, 1500)) return;
        if (attempt === 1) {
          const m = me(room);
          const l = (snap(room).loot as Record<string, any>)[id];
          throw new Error(
            `pickup failed for ${id} at (${x}, ${z}): me=(${m.x.toFixed(2)}, ` +
            `${m.z.toFixed(2)}) carrying=${m.carrying} phase=${snap(room).phase} ` +
            `item[carrier=${JSON.stringify(l?.carrier)} extracted=${l?.extracted}]`
          );
        }
      }
    }

    // loot picks are randomized per room: select targets from live state,
    // skipping anything not reachable with gates closed (the archives pair)
    const spawnNode = nav.nearestVisibleNode(pos.x, pos.z);
    const openWorld = nav.reachable(spawnNode, () => false);
    const eligible = (l: any) =>
      l.carrier === "" && !l.extracted &&
      openWorld.has(nav.nearestVisibleNode(l.x, l.z));

    // Quota is a VALUE target, so this is ~7 average items — the same amount
    // of walking the old item-count quota of 7 asked for.
    let banked = 0;
    while (banked < PACE_QUOTA) {
      for (let i = 0; i < CARRY_CAPACITY; i++) {
        const ground = (Object.entries(snap(room).loot) as [string, any][])
          .filter(([, l]) => eligible(l))
          .sort(
            ([, a], [, b]) =>
              Math.hypot(a.x - pos.x, a.z - pos.z) -
              Math.hypot(b.x - pos.x, b.z - pos.z)
          );
        if (!ground.length) throw new Error("no eligible ground loot left");
        const [id, target] = ground[0];
        await grab(id, target.x, target.z);
      }
      await walkTo(L.extractionZone.x, L.extractionZone.z);
      // banking is a server tick away, so wait for hands to actually empty
      if (!(await waitFor(() => me(room).carrying === 0, 3000))) {
        throw new Error(
          `banking did not empty hands (carrying=${me(room).carrying}, ` +
          `phase=${snap(room).phase})`
        );
      }
      banked = snap(room).extractedTotal;
    }

    const s = snap(room);
    const elapsed = (Date.now() - startedAt) / 1000;
    assert(s.phase === "ended" && s.win === true, "quota met -> WIN");
    assert(
      s.extractedTotal >= PACE_QUOTA,
      `${PACE_QUOTA}+ value extracted (banked ${s.extractedTotal})`
    );
    console.log(
      `  >> walk-speed known-map run: ${elapsed.toFixed(0)}s of ${ROUND_SECONDS}s ` +
      `(${((elapsed / ROUND_SECONDS) * 100).toFixed(0)}% of the timer)`
    );
    assert(elapsed < ROUND_SECONDS, "completable within the round timer");
    await room.leave();
  }

  console.log("MAP SMOKE TEST PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("MAP SMOKE TEST FAIL:", err);
  process.exit(1);
});



