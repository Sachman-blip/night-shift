# NIGHT SHIFT

Browser-based 1-4 player co-op horror extraction game (Lethal Company /
Phasmophobia inspired). Three.js + Rapier on the client, Colyseus on the
server, low-poly flat-shaded art carried by fog, lighting, and (later) sound.

## Play it

No install, no account. Open the link, press **START A SHIFT**, and send the
4-letter room code to up to three friends. Runs in a desktop or phone browser.

- **Play:** https://dist-sooty-ten-wrihij32v2.vercel.app
- **Trailer:** https://night-shift-trailer.vercel.app

Bring a mic and someone you trust. You each get one flashlight and three loot
slots. Grab what you can, bank the quota at the loading dock, and get out before
the six-minute clock runs down. Get caught and you drop your whole haul where
you fall. The monster runs on the server, so nobody can peek through walls at
it and it can't cheat you either.

## Run it

```bash
npm install
npm run dev        # starts server (ws://localhost:2567) + client (http://localhost:5173)
```

Open http://localhost:5173, hit **START A SHIFT**, and share the 4-letter
code. Friends on the same LAN can join via `http://<your-ip>:5173`.

| Script | What it does |
| --- | --- |
| `npm run dev` | server + client together |
| `npm run dev:server` / `dev:client` | each side alone |
| `npm run check` | typecheck both workspaces |
| `npm run smoke -w server` | 2-client netcode test (server must be running) |
| `npm run smoke:enemy -w server` | enemy AI state-machine test (server must be running) |
| `npm run smoke:round -w server` | loot/extraction/round-lifecycle test (server must be running) |
| `npm run smoke:shift -w server` | escalating shift progression (win advances/escalates, loss repeats) |
| `npm run smoke:map -w server` | loot spread, gates, patrol coverage, paced full-round bot |

Controls: **WASD** move · **Shift** sprint · **Space** jump · **F** flashlight
· click to capture the mouse.

## Architecture

```
shared/     protocol + map data (single source of truth, zero dependencies)
  messages.ts   message names, rates, payload shapes
  map.ts        box-list geometry, spawns, bounds, light fixtures
server/     Colyseus 0.16 (Node)
  GameRoom      4-letter room codes, 20hz state patches, bounds clamping
client/     Vite + Three.js + Rapier (WASM)
  PlayerController   pointer-lock FPS on Rapier's KinematicCharacterController
  RemotePlayers      interpolated human figures + name tags + torches for teammates
  buildMap           meshes AND colliders generated from shared/map.ts
```

Design decisions (locked in):
- **First-person**, flashlight cone is the view.
- **Client-authoritative movement** (co-op, no PvP): your client simulates,
  server clamps to map bounds and rejects non-finite values, then relays.
  Enemy AI will be **server-side** so it can't be cheated and stays in sync.
- Map geometry is data (`MAP_BOXES`), not hand-placed meshes — the server can
  reuse it for AI line-of-sight/pathing, and Phase 3's room-chunk shuffling
  is "generate a different box list" rather than a rewrite.

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
      Note: layout is rolled per ROOM; NEXT SHIFT replays the same
      arrangement (client-side map rebuild on restart is future work).
- [x] **Mobile/touch support**: dynamic virtual joystick (rim deflection =
      sprint), right-side drag look, GRAB/JUMP/LIGHT buttons, responsive
      HUD w/ safe-area insets, landscape hint, mobile render tier (1.5x
      pixel ratio cap, 1024px shadows, no SMAA). Force with `?touch=1`;
      phones on the LAN join via `http://<pc-ip>:5173`. Verified by
      `tools/touch-test.mjs` (emulated-touch e2e against synced state).
- [ ] **Phase 3b — remaining**: layout regeneration on round restart,
      2-3 monster variants
- [ ] **Phase 4 — proximity voice** (WebRTC, volume by in-game distance)
