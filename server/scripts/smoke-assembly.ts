// Layout assembly test — pure functions, no server needed:
//   npm run smoke:assembly -w server
//
// Generates 30 random arrangements and asserts every constraint the
// generator promises: geometry-clear nav edges + patrol routes, full
// reachability, gates-closed access to keycard/breaker/extraction,
// spawn<->extraction graph distance, and loot spread.

import {
  buildLayout,
  IDENTITY_LAYOUT,
  LOOT_COUNT,
  KEYCARD_CARRIERS,
} from "../../shared/map";
import { generateLayout, randomDescriptor, validateLayout } from "../src/layout";
import { createLos } from "../src/ai/los";
import { createNav } from "../src/ai/nav";

function assert(cond: unknown, label: string) {
  if (!cond) throw new Error(`assert failed: ${label}`);
}

const RUNS = 30;
const seen = new Set<string>();
let flippedCount = 0;

// identity layout must always be valid (tests pin it)
generateLayout(IDENTITY_LAYOUT);
console.log("  ok: identity layout valid");

for (let i = 0; i < RUNS; i++) {
  const desc = randomDescriptor();
  const { layout, lootPicks } = generateLayout(desc);
  seen.add(JSON.stringify(desc));
  if (desc.flipped) flippedCount++;

  // re-run the validator explicitly (generateLayout already did — belt & braces)
  const los = createLos(layout.boxes, layout.gateDoors);
  const nav = createNav(layout.navNodes, layout.navEdges, los);
  validateLayout(layout, los, nav);

  // loot spread on the actual picks
  assert(lootPicks.length === LOOT_COUNT, `run ${i}: ${LOOT_COUNT} loot picks`);
  for (let a = 0; a < lootPicks.length; a++) {
    for (let b = a + 1; b < lootPicks.length; b++) {
      const d = Math.hypot(
        lootPicks[a].x - lootPicks[b].x,
        lootPicks[a].z - lootPicks[b].z
      );
      assert(d >= 4.5, `run ${i}: loot pair only ${d.toFixed(1)}m apart`);
    }
  }
  assert(
    lootPicks.filter((l) => l.locked).length === 2,
    `run ${i}: archives jackpot included`
  );

  // spawn/extraction far apart (also enforced inside validateLayout)
  const spawn = layout.spawnPoints[0];
  const zone = layout.extractionZone;
  assert(
    Math.hypot(spawn.x - zone.x, spawn.z - zone.z) >= 40,
    `run ${i}: spawn-extraction euclidean distance`
  );

  // patrol never uses gated edges & visits both wings
  const xs = layout.patrolRoute.map((id) => layout.navNodes[id].x);
  assert(Math.min(...xs) < 10 && Math.max(...xs) > 30, `run ${i}: patrol spans both wings`);
}

console.log(`  ok: ${RUNS} random layouts all satisfy constraints`);
console.log(`  ok: ${seen.size}/${RUNS} descriptors distinct, ${flippedCount} flipped`);
console.log(
  `  info: nominal arrangement space = 3! x 2 x 2 x 3! x 2 x ${KEYCARD_CARRIERS.length} = ` +
  `${6 * 2 * 2 * 6 * 2 * KEYCARD_CARRIERS.length} (x randomized loot placement per round)`
);
console.log("ASSEMBLY SMOKE TEST PASS");
