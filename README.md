# NIGHT SHIFT

Browser-based 1-4 player co-op horror extraction game (Lethal Company /
Phasmophobia inspired). Three.js + Rapier on the client, Colyseus on the
server, low-poly flat-shaded art carried by fog, lighting, and synthesized sound.

## Play it

No install, no account. Open the link, press **START A SHIFT**, and send the
4-letter room code to up to three friends. Runs in a desktop or phone browser.

- **Play:** https://dist-sooty-ten-wrihij32v2.vercel.app
- **Trailer:** https://night-shift-trailer.vercel.app

Bring a mic and someone you trust. You each get one flashlight, one spare cell
and three loot slots. Grab what you can, bank the quota at the loading dock,
and get out before the clock runs down — six minutes solo, ten with a crew, and
less every shift you clear.

Being quiet is the whole game. The monster's hearing scales with the noise you
are actually making, so sprinting is a decision and not a default; crouch and
you are nearly silent and much harder to see, at just under half walking pace.
Your flashlight burns a battery that only drains while the beam is on, which
makes the dark a resource you spend.

Get caught and you drop your whole haul and go down where you fell, bleeding
out with about forty-five seconds for somebody to hold **E** over you. Alone,
nobody is coming. Whatever you bank pays the crew credits between shifts, which
buy carry slots, quieter boots, more sprint, and spare cells. The building is
re-arranged every shift, so nobody ever runs it from memory.

The monster runs on the server, so nobody can peek through walls at it and it
can't cheat you either.

## Run it

```bash
npm install
npm run dev        # starts server (ws://localhost:2567) + client (http://localhost:5173)
```

Open http://localhost:5173, hit **START A SHIFT**, and share the 4-letter
code. Friends on the same LAN can join via `http://<your-ip>:5173`.

A fresh clone needs nothing but `npm install` — everything the game and both
deploys need is in the repo. `screenshots/` is git-ignored and regenerates
from the scripts in `tools/`. For how the live game is hosted, and the
Render/Vercel traps worth knowing before you touch either, see
[DEPLOYMENT.md](DEPLOYMENT.md).

The `smoke:*` scripts drive a real client against a running server, so start
one first (`npm run dev:server`) — `smoke:assembly` is the exception and runs
on its own.

| Script | What it does |
| --- | --- |
| `npm run dev` | server + client together |
| `npm run dev:server` / `dev:client` | each side alone |
| `npm run check` | typecheck both workspaces |
| `npm run smoke -w server` | 2-client netcode test |
| `npm run smoke:enemy -w server` | enemy AI state-machine test |
| `npm run smoke:round -w server` | loot/extraction/round-lifecycle test |
| `npm run smoke:shift -w server` | escalating shift progression (win advances/escalates, loss repeats) |
| `npm run smoke:map -w server` | loot spread, gates, patrol coverage, paced full-round bot |
| `npm run smoke:systems -w server` | stealth, gear, rescue, economy (5 sections) |
| `npm run smoke:reroll -w server` | the between-shift map re-roll, and the AI navigating the new plan |
| `npm run smoke:assembly -w server` | 30 random layouts vs all constraints (pure, no server) |
| `npm run smoke:stamina -w server` | server-side sprint speed clamp |
| `npm run smoke:voice -w server` | WebRTC signaling relay |

Controls: **WASD** move · **Shift** sprint · **C** toggle crouch or hold **X** ·
**Space** jump · **F** flashlight · **R** load a fresh cell · **E** interact
(grab loot, or hold over a downed teammate to revive them) ·
click to capture the mouse.

## Architecture

```
shared/     protocol + map data (single source of truth, zero dependencies)
  messages.ts   message names, rates, payload shapes, movement/noise/gear tuning
  map.ts        chunk geometry, nav graph, spawns, bounds, light fixtures
  loot.ts       loot types + values, round/shift scaling, the upgrade shop
server/     Colyseus 0.16 (Node)
  GameRoom      4-letter room codes, 20hz state patches, bounds clamping,
                extraction, downed/revive, credits
  ai/EnemyAI    patrol -> chase -> search, perception
  ai/los, ai/nav  sight rays and the pathfinder over the layout's nav graph
  layout        assembles + validates a room's arrangement, picks loot spots
client/     Vite + Three.js + Rapier (WASM)
  PlayerController   pointer-lock FPS on Rapier's KinematicCharacterController
  RemotePlayers      interpolated human figures + name tags + torches for teammates
  buildMap           meshes AND colliders generated from shared/map.ts
  voice              WebRTC mesh with distance-driven per-peer gain
```

Design decisions (locked in):
- **First-person**, flashlight cone is the view.
- **Client-authoritative movement** (co-op, no PvP): your client simulates,
  server clamps to map bounds and rejects non-finite values, then relays.
  Enemy AI is **server-side** so it can't be cheated and stays in sync.
- **Anything the monster reacts to is measured, not claimed.** Speed comes from
  the positions the server observes, and noise is derived from that speed — a
  client can send whatever flags it likes without gaining an advantage.
- Map geometry is data, not hand-placed meshes — the server reuses it for AI
  line-of-sight/pathing, and re-arranging the building is "generate a different
  box list" rather than a rewrite. Client and server expand the same synced
  descriptor through `buildLayout`, so they cannot disagree about the map.

## Roadmap

- [x] **Phase 1a — scaffold**: rooms w/ shareable codes, 20hz sync, FPS
      controller, dark office test map, flashlight w/ shadows, flickering
      fluorescents, remote player rendering
- [x] **Phase 1b (enemy)**: server-authoritative AI (patrol → chase →
      search via hand-authored nav graph over `shared/nav.ts`, hearing
      radius + LOS vision cone raycast against MAP_BOXES), contact kill →
      respawn w/ 3s invulnerability, glowing-eyes placeholder rendering
- [x] **Phase 2 — core loop + scary**: 10 loot items across 6 types
      (`shared/loot.ts`, data-driven), carry capacity 3, E to grab, death
      drops your haul at the kill spot; extraction zone at the west entrance
      banks loot, team quota 5 wins, 6-minute timer loses; results screen +
      NEXT SHIFT restart; synthesized audio (ambient drone, footsteps,
      enemy-proximity growl/heartbeat, event stingers); HUD (timer,
      carried/banked, teammates, grab prompt). Round settings tunable via
      room create options (`quota`, `roundSeconds`, `noEnemy` for tests).
- [x] **Phase 2.5 — bigger, harder, dressed**: map expanded to two wings
      (~60m x 36m, 14 spaces): cubicle floor, conference, print room,
      keycard-locked archives, maintenance w/ breaker, south hall, three
      dead-end closets, loading-dock extraction at the far east end.
      Composite furniture (desks w/ legs, chairs, monitors, cabinets,
      shelf units, partitions) merged into one mesh per color for perf.
      16 loot items spread map-wide (min 5m apart), glow cut to
      flashlight-only visibility. Enemy patrol covers both wings; gated
      nav edges open with keycard/breaker. Zone-tinted lighting, deco
      clutter, random false-alarm ambient sounds.
- [x] **Phase 3 — replayability + polish**: stamina-limited sprint (~5.5s
      drain / ~3.5s regen, server-enforced via observed-speed token bucket);
      composite loot models (7 recognizable silhouettes); chunk-based map
      randomization — room contents permute across same-size slots on a
      fixed corridor skeleton, spawn/extraction ends flip, keycard moves
      (1,152 arrangements x random loot placement), synced as a JSON
      descriptor in room state and expanded identically by client+server
      (`buildLayout` in shared/map.ts); per-layout patrol routes + nav
      validation; post-processing (bloom, vignette, grain, SMAA), PBR
      materials, 2048px flashlight shadows. Tests: `smoke:assembly` (30
      random layouts vs all constraints), `smoke:stamina` (speed clamp),
      `tools/capture.mjs` (screenshots + FPS with 4 players).
- [x] **Mobile/touch support**: dynamic virtual joystick (rim deflection =
      sprint), right-side drag look, GRAB/JUMP/LIGHT buttons, responsive
      HUD w/ safe-area insets, landscape hint, mobile render tier (1.5x
      pixel ratio cap, 1024px shadows, no SMAA). Force with `?touch=1`;
      phones on the LAN join via `http://<pc-ip>:5173`. Verified by
      `tools/touch-test.mjs` (emulated-touch e2e against synced state).
- [x] **Phase 3b**: the building is re-rolled on every round restart (server
      re-generates, re-points each live AI at the new nav/sight systems via
      `setWorld`, and the client rebuilds meshes + colliders when the synced
      descriptor changes); three monster variants rolled per round — `stalker`
      (sees far, hears little), `listener` (near-blind, hears through walls),
      `sprinter` (fast, poor senses). Tested by `smoke:reroll`, which asserts
      the AI patrols the *new* floor plan and never ends up inside its walls.
- [x] **Phase 4 — proximity voice**: WebRTC mesh signalled through the room
      (the server relays opaque SDP/ICE and never inspects it), per-peer gain
      driven by the positions already synced at 20hz, so a teammate fades in
      as they get close. `smoke:voice` covers the relay.
- [x] **Phase 5 — stealth, gear, rescue, economy**: noise tiers derived
      from the speed the SERVER observes (idle 0.25 / crouch 0.4 / walk 1 /
      sprint 1.75) scaling the monster's hearing radius, so claiming to crouch
      while sprinting buys nothing; crouch at 1.55 m/s also shrinks your
      silhouette while a lit torch enlarges it. Flashlight
      batteries that drain only while the beam is lit, with swappable cells.
      Getting caught downs you instead of killing you: you drop the haul, bleed
      out over 45s, and a teammate holding **E** for 4s brings you back — with
      nobody left standing there is no rescue, so you respawn at the usual
      cost. Banked value pays crew credits between shifts, spent on carry
      slots / quieter boots / sprint conditioning / spare cells. Covered by
      `smoke:systems`.
