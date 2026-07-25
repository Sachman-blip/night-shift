// Stealth / gear / rescue / economy test.
//   npm run smoke:systems -w server        (sections 2+ need the server up)
//
// Sections, in dependency order (a failure stops everything after it):
//   1. perception math — noise-scaled hearing, plus torch and crouch vision
//      (pure, in-process)
//   2. noise tiers derive from the speed the SERVER observes
//   3. flashlight battery drains on the beam, not the clock
//   4. getting caught downs you; a teammate can pull you back up
//   5. banking pays credits and the shop actually changes the run
//
// The map is pinned (IDENTITY_LAYOUT) throughout so every coordinate below
// is deterministic.

import { Client, type Room } from "colyseus.js";
import {
  ROOM_NAME,
  MSG,
  NOISE_IDLE,
  NOISE_CROUCH,
  NOISE_WALK,
  NOISE_SPRINT,
  BASE_CELLS,
  REVIVE_SECONDS,
  BLEED_OUT_SECONDS,
} from "../../shared/messages";
import { buildLayout, IDENTITY_LAYOUT } from "../../shared/map";
import { CARRY_CAPACITY, carryCapacityFor, upgradeCost } from "../../shared/loot";
import { createLos } from "../src/ai/los";
import { createNav } from "../src/ai/nav";
import { EnemyAI, type EnemyWorld } from "../src/ai/EnemyAI";
import { Enemy, Player } from "../src/schema/GameState";

const ENDPOINT = process.env.ENDPOINT ?? "ws://localhost:2567";
const PARK = { x: -12, z: -6.75 }; // slot n0: off the identity patrol route
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const L = buildLayout(IDENTITY_LAYOUT);
const los = createLos(L.boxes, L.gateDoors);
const nav = createNav(L.navNodes, L.navEdges, los);

const snap = (room: Room) => (room.state as any).toJSON();
const me = (room: Room) => snap(room).players[room.sessionId];

interface PosOpts {
  torch?: boolean;
  crouch?: boolean;
}
function sendPos(room: Room, x: number, z: number, o: PosOpts = {}) {
  room.send(MSG.Move, {
    x, y: 1.05, z, yaw: 0, pitch: 0,
    torch: o.torch ?? false,
    crouch: o.crouch ?? false,
  });
}

function assert(cond: unknown, label: string) {
  if (!cond) throw new Error(`assert failed: ${label}`);
  console.log(`  ok: ${label}`);
}

async function waitFor(
  room: Room, label: string, pred: (s: any) => boolean, timeoutMs: number
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

/** Drive the player at a fixed pace so the server observes a chosen speed. */
async function holdSpeed(
  room: Room, from: { x: number; z: number }, metresPerTick: number,
  ticks: number, o: PosOpts = {}
) {
  let z = from.z;
  for (let i = 0; i < ticks; i++) {
    // alternate direction so the player stays put but keeps "moving"
    z += (i % 2 === 0 ? 1 : -1) * metresPerTick;
    sendPos(room, from.x, z, o);
    await sleep(100); // server clamps dt to >= 0.04s; 0.1s is the real gap
  }
  await sleep(120);
}

// ---------------------------------------------------------------------
// 1. perception math (pure)
// ---------------------------------------------------------------------

function makeWorld(): EnemyWorld {
  return {
    los, nav,
    route: L.patrolRoute,
    spawn: L.enemySpawn,
    isGateOpen: () => false,
  };
}

function makePlayer(x: number, z: number, p: Partial<Player> = {}): Player {
  const player = new Player();
  player.x = x;
  player.z = z;
  player.y = 1.05;
  player.noise = NOISE_IDLE;
  player.torch = false;
  player.crouching = false;
  Object.assign(player, p);
  return player;
}

/** One perception tick: does this enemy pick the player up? */
function detects(
  variant: "stalker" | "listener" | "sprinter",
  at: { x: number; z: number; yaw: number },
  player: Player,
  world = makeWorld()
): boolean {
  const e = new Enemy();
  const ai = new EnemyAI(e, world);
  ai.reset(variant);
  e.x = at.x;
  e.z = at.z;
  e.y = 1.05;
  e.yaw = at.yaw;
  ai.update(0.05, Date.now(), [{ sessionId: "s", player, invulnerable: false }], () => {});
  return e.aiState === "chase";
}

// yaw such that the enemy's forward vector is -x (it faces away from +x)
const FACE_NEG_X = Math.PI / 2;
// yaw 0 => forward is -z
const FACE_NEG_Z = 0;

function perceptionSection() {
  console.log("[1] perception math (noise, torch, crouch)");

  // -- hearing scales with noise, and ignores walls by design --
  const listenerAt = { x: 0, z: 0, yaw: FACE_NEG_X };
  assert(
    !detects("listener", listenerAt, makePlayer(5, 0, { noise: NOISE_CROUCH })),
    "listener (hear 9) misses a crouching player at 5m (9 x 0.4 = 3.6m)"
  );
  assert(
    detects("listener", listenerAt, makePlayer(5, 0, { noise: NOISE_WALK })),
    "listener hears the same player walking (9 x 1.0 = 9m)"
  );
  assert(
    detects("listener", listenerAt, makePlayer(12, 0, { noise: NOISE_SPRINT })),
    "listener hears a sprinter from 12m (9 x 1.75 = 15.75m)"
  );

  // -- a lit flashlight extends how far you can be SEEN --
  assert(los.losClear(12, 0, -3, 0), "corridor sightline (12,0)->(-3,0) is clear");
  const stalkerAt = { x: 12, z: 0, yaw: FACE_NEG_X };
  assert(
    !detects("stalker", stalkerAt, makePlayer(-3, 0, { noise: NOISE_IDLE })),
    "stalker (vision 13) misses a dark, silent player at 15m"
  );
  assert(
    detects("stalker", stalkerAt, makePlayer(-3, 0, { noise: NOISE_IDLE, torch: true })),
    "...but the same player with the torch on is seen (13 x 1.35 = 17.6m)"
  );

  // -- crouching shrinks your silhouette --
  assert(
    detects("stalker", stalkerAt, makePlayer(2, 0, { noise: NOISE_IDLE })),
    "stalker sees a standing player at 10m"
  );
  assert(
    !detects("stalker", stalkerAt, makePlayer(2, 0, {
      noise: NOISE_CROUCH, crouching: true,
    })),
    "...but not a crouched one (13 x 0.62 = 8.1m)"
  );

}

// ---------------------------------------------------------------------

async function main() {
  perceptionSection();

  // One quiet, monster-free room carries the noise and battery sections.
  const room = await new Client(ENDPOINT).create(ROOM_NAME, {
    name: "Sneak", noEnemy: true, freeMove: true,
    layout: IDENTITY_LAYOUT, enemies: 1, roundSeconds: 600,
  });
  room.onMessage(MSG.Teleport, () => {});
  // `players` itself is absent until the first patch lands, so reach for it
  // defensively rather than assuming the map exists yet.
  await waitFor(room, "test room ready", (s) => !!s.players?.[room.sessionId], 5000);

  // ---- 2. noise tiers from observed speed ----
  console.log("[2] noise is derived from observed speed, not from the flag");
  {
    sendPos(room, PARK.x, PARK.z);
    await sleep(200);

    await holdSpeed(room, PARK, 0.05, 6, { crouch: true }); // 0.5 m/s, ducked
    assert(
      Math.abs(me(room).noise - NOISE_CROUCH) < 0.001,
      `crouch-walking reads as ${NOISE_CROUCH} (got ${me(room).noise})`
    );
    assert(me(room).crouching === true, "server agrees the player is crouched");

    await holdSpeed(room, PARK, 0.3, 6); // 3 m/s, upright
    assert(
      Math.abs(me(room).noise - NOISE_WALK) < 0.001,
      `walking reads as ${NOISE_WALK} (got ${me(room).noise})`
    );

    // the giveaway: claim to be crouching while moving at sprint pace
    await holdSpeed(room, PARK, 0.6, 6, { crouch: true }); // 6 m/s
    assert(
      Math.abs(me(room).noise - NOISE_SPRINT) < 0.001,
      `sprinting while "crouched" still reads as ${NOISE_SPRINT} (got ${me(room).noise})`
    );
    assert(me(room).crouching === false, "and the crouch flag is rejected outright");

    // standing still
    for (let i = 0; i < 4; i++) {
      sendPos(room, PARK.x, PARK.z);
      await sleep(100);
    }
    await sleep(150);
    assert(
      Math.abs(me(room).noise - NOISE_IDLE) < 0.001,
      `standing still reads as ${NOISE_IDLE} (got ${me(room).noise})`
    );
  }

  // ---- 3. flashlight battery ----
  console.log("[3] flashlight battery");
  {
    assert(me(room).cells === BASE_CELLS, `starts with ${BASE_CELLS} spare cell`);
    // the torch starts ON, so a sliver is already gone by the time we look
    assert(me(room).battery > 0.99, `cell starts essentially full (${me(room).battery})`);

    // a full cell has nothing to swap in
    room.send(MSG.Swap);
    await sleep(250);
    assert(me(room).cells === BASE_CELLS, "swap refused at full charge");

    for (let i = 0; i < 25; i++) {
      sendPos(room, PARK.x, PARK.z, { torch: true });
      await sleep(100);
    }
    assert(
      me(room).battery < 0.995,
      `beam drained the cell (battery=${me(room).battery.toFixed(4)})`
    );

    // settle first: an in-flight lit tick would otherwise land on the baseline
    for (let i = 0; i < 3; i++) {
      sendPos(room, PARK.x, PARK.z, { torch: false });
      await sleep(100);
    }
    const dark = me(room).battery;
    for (let i = 0; i < 15; i++) {
      sendPos(room, PARK.x, PARK.z, { torch: false });
      await sleep(100);
    }
    assert(me(room).battery === dark, "a dark torch costs nothing (1.5s, no change)");
  }
  await room.leave();

  // ---- 4. downed & revive ----
  console.log("[4] getting caught downs you; a teammate pulls you back up");
  {
    const clientA = new Client(ENDPOINT);
    const a = await clientA.create(ROOM_NAME, {
      name: "Victim", freeMove: true, layout: IDENTITY_LAYOUT,
      variant: "stalker", enemies: 1, roundSeconds: 600,
    });
    a.onMessage(MSG.Teleport, () => {});
    const b = await new Client(ENDPOINT).joinById(a.roomId, { name: "Rescuer" });
    b.onMessage(MSG.Teleport, () => {});
    await sleep(400);
    sendPos(a, PARK.x, PARK.z);
    sendPos(b, PARK.x, PARK.z);
    await sleep(3800); // round-start invulnerability

    // walk A onto the monster until it lands a hit
    const t0 = Date.now();
    while (!me(a).downed && Date.now() - t0 < 20000) {
      const e = snap(a).enemies.e0;
      sendPos(a, e.x, e.z);
      await sleep(100);
    }
    assert(me(a).downed === true, "A is on the floor, not respawned");
    assert(me(a).bleed > 0 && me(a).bleed <= BLEED_OUT_SECONDS, "bleed-out clock running");
    assert(me(a).carrying === 0, "A dropped everything");

    const downSpot = { x: me(a).x, z: me(a).z };
    // A must stay put while downed even if their client keeps talking
    sendPos(a, PARK.x, PARK.z);
    await sleep(250);
    assert(
      Math.hypot(me(a).x - downSpot.x, me(a).z - downSpot.z) < 0.01,
      "a downed player cannot move themselves"
    );

    // B walks over and holds interact
    sendPos(b, downSpot.x, downSpot.z);
    await sleep(200);
    const startedAt = Date.now();
    while (me(a).downed && Date.now() - startedAt < 12000) {
      b.send(MSG.Revive);
      await sleep(100);
    }
    const took = (Date.now() - startedAt) / 1000;
    assert(!me(a).downed, `A was pulled back up in ${took.toFixed(1)}s`);
    assert(
      took >= REVIVE_SECONDS - 0.6 && took <= REVIVE_SECONDS + 2.5,
      `revive took about ${REVIVE_SECONDS}s of holding`
    );
    assert(me(a).reviveProgress === 0, "revive progress cleared");
    await a.leave();
    await b.leave();
  }

  // ---- 5. credits & the shop ----
  console.log("[5] banking pays credits and the shop changes the next shift");
  {
    const shop = await new Client(ENDPOINT).create(ROOM_NAME, {
      name: "Buyer", noEnemy: true, freeMove: true,
      layout: IDENTITY_LAYOUT, enemies: 1, quota: 30, roundSeconds: 600,
    });
    shop.onMessage(MSG.Teleport, () => {});
    await sleep(300);
    sendPos(shop, PARK.x, PARK.z);
    await sleep(150);
    assert(snap(shop).credits === 0, "a fresh crew has no credit");

    // teleport-bank until the value quota is met
    const ground = () =>
      (Object.entries(snap(shop).loot) as [string, any][])
        .filter(([, l]) => l.carrier === "" && !l.extracted);
    const t0 = Date.now();
    while (snap(shop).phase === "active" && Date.now() - t0 < 40000) {
      while (me(shop).carrying < CARRY_CAPACITY) {
        const g = ground();
        if (!g.length) break;
        sendPos(shop, g[0][1].x, g[0][1].z);
        shop.send(MSG.Pickup);
        await sleep(160);
      }
      if (me(shop).carrying === 0) break;
      sendPos(shop, L.extractionZone.x, L.extractionZone.z);
      await sleep(250);
    }
    assert(snap(shop).phase === "ended" && snap(shop).win, "quota cleared");

    const credits = snap(shop).credits;
    const capacityCost = upgradeCost("capacity", 0)!;
    assert(credits >= capacityCost, `earned ${credits} CR (cargo rig costs ${capacityCost})`);

    shop.send(MSG.Buy, { id: "capacity" });
    await waitFor(shop, "cargo rig purchased", (s) => s.upgrades.capacity === 1, 2000);
    assert(
      snap(shop).credits === credits - capacityCost,
      `credits debited (${credits} -> ${snap(shop).credits})`
    );

    // spending you cannot afford is a no-op
    const before = snap(shop).credits;
    for (let i = 0; i < 6; i++) shop.send(MSG.Buy, { id: "capacity" });
    shop.send(MSG.Buy, { id: "nonsense" });
    await sleep(400);
    assert(
      snap(shop).credits <= before && snap(shop).upgrades.capacity <= 2,
      "over-spending and unknown ids are ignored"
    );

    // and the upgrade is real: one more slot on your back next shift
    shop.send(MSG.Restart);
    await waitFor(shop, "next shift started", (s) => s.phase === "active", 3000);
    await sleep(500); // round reset ignores moves for a moment after teleporting
    const want = carryCapacityFor(snap(shop).upgrades.capacity);
    for (let i = 0; i < want + 2; i++) {
      const g = ground();
      if (!g.length) break;
      sendPos(shop, g[0][1].x, g[0][1].z);
      shop.send(MSG.Pickup);
      await sleep(180);
    }
    assert(
      want > CARRY_CAPACITY && me(shop).carrying === want,
      `carry capacity is now ${want} (was ${CARRY_CAPACITY}), carrying ${me(shop).carrying}`
    );
    await shop.leave();
  }

  console.log("SYSTEMS SMOKE TEST PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("SYSTEMS SMOKE TEST FAIL:", err);
  process.exit(1);
});
