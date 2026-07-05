// Layout engine: the facility is a fixed circulation skeleton (corridors,
// perimeter, dock, cubicle floor, conference, print) plus room CHUNKS that
// permute across same-size slots each time a room is created. The server
// picks a LayoutDescriptor, validates it, and syncs it as JSON in room
// state; client and server both expand it with buildLayout() so everyone
// sees the identical world.
//
// Slots (fixed frames):        Chunk pools:
//   north x3 (12 x 10.5)         offices / lobby / ward
//   south x2 (18 x 10.5)         storage / cafeteria
//   east  x2 (10 x 8.5)          archives (gated) / maintenance (breaker)
//   closet x3 (8 x 5)            janitor / server / private office
// Plus: flipped (spawn<->extraction ends), keycard carrier chunk.

export interface BoxDef {
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  color: number;
  /** Decorative only: rendered, but no physics collider. */
  deco?: boolean;
}

export type GateId = "archives" | "shortcut";

export interface GateDoorDef {
  gate: GateId;
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  color: number;
}

export type LightMode = "on" | "flicker" | "off";
export interface LightDef { x: number; z: number; mode: LightMode; color?: number }

export interface NavNode { x: number; z: number }
export interface NavEdge { a: string; b: string; gate?: GateId }

export interface LootCandidate { kind: string; x: number; z: number; locked?: boolean }

export interface LayoutDescriptor {
  north: [number, number, number];   // permutation of [offices, lobby, ward]
  south: [number, number];           // permutation of [storage, cafeteria]
  east: [number, number];            // permutation of [archives, maintenance]
  closets: [number, number, number]; // permutation of [janitor, server, office]
  flipped: boolean;                  // spawn at dock, extract at west end
  keycard: number;                   // index into KEYCARD_CARRIERS
}

export interface Layout {
  boxes: BoxDef[];
  gateDoors: GateDoorDef[];
  lights: LightDef[];
  navNodes: Record<string, NavNode>;
  navEdges: NavEdge[];
  patrolRoute: string[];
  spawnPoints: { x: number; z: number }[];
  extractionZone: { x: number; z: number; sx: number; sz: number };
  enemySpawn: { x: number; z: number };
  keycardPos: { x: number; z: number; y: number };
  breakerPos: { x: number; z: number };
  lootCandidates: LootCandidate[];
}

export const WALL_HEIGHT = 3.2;
const H = WALL_HEIGHT;
const T = 0.3;
export const INTERACT_RADIUS = 1.8;
export const LOOT_COUNT = 15;

export const MAP_BOUNDS = {
  minX: -17.7, maxX: 41.7,
  minZ: -17.7, maxZ: 17.7,
  yMax: 4,
};

export const COLORS = {
  floor: 0x4a473d, ceiling: 0x3a3d36, wall: 0x77806a, partition: 0x8a8f84,
  wood: 0x5c4a33, woodLight: 0x74603f, metal: 0x585c60, metalDark: 0x3c4044,
  gurney: 0x8a9296, crate: 0x6b5b3e, sofa: 0x5a4a52, reception: 0x4f5a4a,
  vending: 0x6e3a3a, chair: 0x2e3436, screen: 0x16332c, paper: 0xd8d5c8,
  book: 0x6a4a56, binder: 0x3f5a5e, pipe: 0x5a5148, door: 0x4e4438,
  gate: 0x6a7076, serverBox: 0x2a3038, led: 0x77e0a0, mug: 0xc0b8a8,
} as const;

const GREEN = 0xcfe8c4;
const WARM = 0xe8cfa0;
const COLD = 0xc4d8e8;
const AMBER = 0xe8b070;

// ---------------------------------------------------------------------
// build context: helpers write into `cur` with `curDX` translation, so
// chunks are authored once at their "home" coordinates.
// ---------------------------------------------------------------------

let cur: Layout;
let curDX = 0;

function box(
  x: number, y: number, z: number,
  sx: number, sy: number, sz: number,
  color: number, deco = false
) {
  cur.boxes.push({ x: x + curDX, y, z, sx, sy, sz, color, deco });
}

const wallX = (x1: number, x2: number, z: number) =>
  box((x1 + x2) / 2, H / 2, z, x2 - x1, H, T, COLORS.wall);
const wallZ = (x: number, z1: number, z2: number) =>
  box(x, H / 2, (z1 + z2) / 2, T, H, z2 - z1, COLORS.wall);
const lintel = (x: number, z: number, alongX: boolean, width = 1.6) =>
  box(x, 2.7, z, alongX ? width : T, H - 2.2, alongX ? T : width, COLORS.wall);

const light = (x: number, z: number, mode: LightMode, color?: number) =>
  cur.lights.push({ x: x + curDX, z, mode, color });
const node = (id: string, x: number, z: number) =>
  (cur.navNodes[id] = { x: x + curDX, z });
const edge = (a: string, b: string, gate?: GateId) =>
  cur.navEdges.push({ a, b, gate });
const loot = (kind: string, x: number, z: number, locked = false) =>
  cur.lootCandidates.push({ kind, x: x + curDX, z, locked });

// ---- composite furniture (same primitives-composition as before) ----

function desk(cx: number, cz: number, w = 1.8, d = 0.9) {
  box(cx, 0.74, cz, w, 0.08, d, COLORS.wood);
  const lx = w / 2 - 0.12, lz = d / 2 - 0.12;
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    box(cx + sx * lx, 0.35, cz + sz * lz, 0.08, 0.7, 0.08, COLORS.wood);
}

function chair(cx: number, cz: number, facing: "n" | "s" | "e" | "w") {
  box(cx, 0.48, cz, 0.48, 0.08, 0.48, COLORS.chair);
  const off = 0.24;
  const b: Record<string, [number, number, number, number]> = {
    n: [0, off, 0.48, 0.08], s: [0, -off, 0.48, 0.08],
    e: [-off, 0, 0.08, 0.48], w: [off, 0, 0.08, 0.48],
  };
  const [bx, bz, bw, bd] = b[facing];
  box(cx + bx, 0.85, cz + bz, bw, 0.66, bd, COLORS.chair);
  box(cx, 0.22, cz, 0.08, 0.44, 0.08, COLORS.chair, true);
  box(cx, 0.03, cz, 0.42, 0.06, 0.42, COLORS.chair, true);
}

function monitor(cx: number, cz: number, deskTop = 0.78) {
  box(cx, deskTop + 0.02, cz, 0.24, 0.04, 0.18, COLORS.metalDark, true);
  box(cx, deskTop + 0.1, cz, 0.05, 0.14, 0.05, COLORS.metalDark, true);
  box(cx, deskTop + 0.33, cz, 0.52, 0.34, 0.05, COLORS.screen, true);
}

function cabinet(cx: number, cz: number, alongX = true) {
  const [sx, sz] = alongX ? [0.62, 0.5] : [0.5, 0.62];
  box(cx, 0.75, cz, sx, 1.5, sz, COLORS.metal);
  for (const y of [0.42, 0.82, 1.22])
    box(cx, y, cz, alongX ? sx - 0.06 : 0.04, 0.03, alongX ? 0.04 : sz - 0.06, COLORS.metalDark, true);
}

function shelfUnit(cx: number, cz: number, w = 2.4, alongX = true) {
  const D = 0.5;
  const dims = (lw: number, lh: number, ld: number): [number, number, number] =>
    alongX ? [lw, lh, ld] : [ld, lh, lw];
  const at = (ox: number): [number, number] =>
    alongX ? [cx + ox, cz] : [cx, cz + ox];
  for (const s of [-1, 1]) {
    const [px, pz] = at(s * (w / 2 - 0.03));
    box(px, 0.95, pz, ...dims(0.06, 1.9, D), COLORS.metal);
  }
  const [bx, bz] = alongX ? [cx, cz + D / 2 - 0.02] : [cx + D / 2 - 0.02, cz];
  box(bx, 0.95, bz, ...dims(w, 1.9, 0.05), COLORS.metal);
  for (const y of [0.35, 0.85, 1.35, 1.8])
    box(cx, y, cz, ...dims(w - 0.1, 0.05, D - 0.06), COLORS.metal);
  for (let i = 0; i < 4; i++) {
    const ox = (i / 3 - 0.5) * (w - 0.7) + (i % 2) * 0.1;
    const [px, pz] = at(ox);
    box(px, 0.96, pz, ...dims(0.3, 0.22, 0.2), i % 2 ? COLORS.book : COLORS.binder, true);
  }
}

function gurney(cx: number, cz: number) {
  box(cx, 0.72, cz, 0.9, 0.08, 2.0, COLORS.gurney);
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    box(cx + sx * 0.36, 0.34, cz + sz * 0.85, 0.06, 0.68, 0.06, COLORS.metal);
  box(cx, 0.8, cz - 0.6, 0.86, 0.08, 0.5, COLORS.paper, true);
}

function table(cx: number, cz: number, w = 2.4, d = 1.0) {
  box(cx, 0.74, cz, w, 0.08, d, COLORS.woodLight);
  const lx = w / 2 - 0.15, lz = d / 2 - 0.15;
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    box(cx + sx * lx, 0.35, cz + sz * lz, 0.1, 0.7, 0.1, COLORS.woodLight);
}

function papers(cx: number, cz: number, n = 4, y = 0.012) {
  for (let i = 0; i < n; i++) {
    const a = i * 2.39996;
    box(cx + Math.cos(a) * 0.35 * (1 + i * 0.3), y,
      cz + Math.sin(a) * 0.3 * (1 + i * 0.25),
      0.32, 0.012, 0.24, COLORS.paper, true);
  }
}

const mug = (cx: number, y: number, cz: number) =>
  box(cx, y, cz, 0.1, 0.11, 0.1, COLORS.mug, true);

function overturnedChair(cx: number, cz: number) {
  box(cx, 0.25, cz, 0.5, 0.5, 0.09, COLORS.chair);
  box(cx + 0.3, 0.07, cz + 0.1, 0.66, 0.14, 0.5, COLORS.chair, true);
}

function cubicleCell(cx: number, deskZ: number, chairZ: number, chairFacing: "n" | "s") {
  desk(cx, deskZ, 2.2, 0.75);
  chair(cx + 0.2, chairZ, chairFacing);
  monitor(cx - 0.3, deskZ);
}

// ---------------------------------------------------------------------
// chunks (authored at home coordinates; curDX translates to target slot)
// ---------------------------------------------------------------------

interface Chunk {
  name: string;
  /** Home-slot origin x (curDX = slotOrigin - homeOrigin). */
  home: number;
  build(anchorId: string): void; // boxes, lights, loot, interior nodes/edges
  /** Local anchor node offset used as the slot's nav anchor. */
  anchor: { x: number; z: number };
  /** Node ids (after prefixing) the patrol should visit inside, or []. */
  patrol(prefix: string): string[];
  gated?: boolean;
}

const NORTH_CHUNKS: Chunk[] = [
  {
    name: "offices", home: -18, anchor: { x: -12, z: -6.75 },
    patrol: () => [],
    build() {
      desk(-15, -9); chair(-15, -10.2, "n"); monitor(-15.2, -9);
      desk(-15, -6); chair(-15.2, -4.9, "s"); monitor(-14.8, -6);
      desk(-11, -9); chair(-10.8, -10.2, "n"); monitor(-11, -9.1);
      cabinet(-6.7, -11.3);
      papers(-13, -7.4);
      mug(-14.6, 0.83, -6.1);
      light(-12, -6.75, "flicker");
      loot("files", -15, -9);
      loot("medkit", -7.4, -10.5);
    },
  },
  {
    name: "lobby", home: -18, anchor: { x: -12, z: -6.75 },
    patrol: (p) => [p],
    build() {
      box(-12, 0.5, -8, 3.2, 1.0, 1.1, COLORS.reception);
      box(-12, 1.03, -8, 3.5, 0.06, 1.3, COLORS.reception);
      box(-16.8, 0.35, -3.2, 0.8, 0.7, 2.2, COLORS.sofa);
      box(-17.15, 0.85, -3.2, 0.15, 0.5, 2.2, COLORS.sofa);
      table(-15.4, -3.2, 1.0, 0.7);
      papers(-10.4, -6.9);
      mug(-11.5, 1.11, -7.7);
      light(-12, -6.75, "on");
      loot("radio", -11.5, -8.6);
      loot("files", -16.6, -4.4);
    },
  },
  {
    name: "ward", home: -18, anchor: { x: -12, z: -6.75 },
    patrol: (p) => [p],
    build() {
      gurney(-15, -9.5); gurney(-12, -9.5); gurney(-9, -9.5);
      cabinet(-6.7, -3, false);
      overturnedChair(-14, -4);
      papers(-10, -5.5);
      light(-12, -6.75, "off", COLD);
      loot("medkit", -12, -9.6);
      loot("specimen", -7.6, -4.4);
    },
  },
];

const SOUTH_CHUNKS: Chunk[] = [
  {
    name: "storage", home: -18, anchor: { x: -9, z: 6.75 },
    patrol: (p) => [p],
    build() {
      box(-14, 0.6, 9, 1.2, 1.2, 1.2, COLORS.crate);
      box(-12.6, 0.6, 9.2, 1.2, 1.2, 1.2, COLORS.crate);
      box(-13.3, 1.8, 9.1, 1.2, 1.2, 1.2, COLORS.crate);
      box(-11, 0.5, 4, 1.0, 1.0, 1.0, COLORS.crate);
      shelfUnit(-6, 11.4, 3.0, true);
      // hugging the south end of the west wall: when this chunk lands in
      // slot S1, the wall it hugs is the divider with the `de` door
      shelfUnit(-17.4, 9.5, 2.4, false);
      light(-9, 6.75, "off");
      loot("typewriter", -17.2, 11);
      loot("cashbox", -11, 4.8);
    },
  },
  {
    name: "cafeteria", home: -18, anchor: { x: -9, z: 8.5 },
    patrol: (p) => [p],
    build() {
      table(-12, 6); chair(-12, 4.9, "s"); chair(-12.4, 7.1, "n");
      table(-7, 6); chair(-6.8, 7.1, "n");
      table(-9.5, 9.5); chair(-8.7, 10.4, "n");
      box(-0.7, 1.0, 10.5, 0.9, 2.0, 0.8, COLORS.vending);
      mug(-11.8, 0.84, 6.1);
      papers(-4.5, 8.6, 3);
      light(-9, 6.75, "flicker", WARM);
      loot("cashbox", -7, 6);
      loot("radio", -1.2, 9.6);
    },
  },
];

const EAST_CHUNKS: Chunk[] = [
  {
    name: "archives", home: 18, anchor: { x: 22, z: 2.6 }, gated: true,
    patrol: () => [],
    build(a) {
      shelfUnit(23, 4, 6, true);
      shelfUnit(23, 7, 6, true);
      papers(19.3, 8.2, 3);
      box(19, 0.25, 8.6, 0.5, 0.5, 0.4, COLORS.binder, true);
      light(23, 5.5, "off");
      loot("typewriter", 20.5, 5.5, true);
      loot("medkit", 25.5, 5.5, true);
      // interior ring (a = "<slot>.top" entry node id prefix base)
      node(a, 22, 2.6);
      node(a + "NW", 19, 2.6); node(a + "NE", 27, 2.6);
      node(a + "W", 19, 5.5); node(a + "E", 27, 5.5);
      node(a + "SW", 19, 8.6); node(a + "SE", 27, 8.6);
      node(a + "Bot", 22, 8.6);
      edge(a, a + "NW"); edge(a, a + "NE");
      edge(a + "NW", a + "W"); edge(a + "NE", a + "E");
      edge(a + "W", a + "E"); edge(a + "W", a + "SW"); edge(a + "E", a + "SE");
      edge(a + "SW", a + "Bot"); edge(a + "SE", a + "Bot");
    },
  },
  {
    name: "maintenance", home: 18, anchor: { x: 23, z: 5.5 },
    patrol: (p) => [p],
    build() {
      shelfUnit(18.6, 4.5, 2.4, false);
      shelfUnit(26.5, 9.4, 2.4, true);
      box(27.85, 2.6, 5.5, 0.12, 0.12, 7, COLORS.pipe, true);
      box(27.85, 2.3, 5.5, 0.12, 0.12, 7, COLORS.pipe, true);
      papers(20, 8.5, 3);
      light(23, 5.5, "flicker", AMBER);
      loot("specimen", 27, 2.5);
      cur.breakerPos = { x: 27.7 + curDX, z: 6.6 };
    },
  },
];

const CLOSET_CHUNKS: Chunk[] = [
  {
    name: "janitor", home: 18, anchor: { x: 22, z: 15.5 },
    patrol: (p) => [p],
    build() {
      shelfUnit(18.6, 15.5, 2.4, false);
      box(19.6, 0.4, 17.2, 0.5, 0.8, 0.5, COLORS.crate);
      light(22, 15.5, "off");
      loot("files", 20.5, 16.5);
    },
  },
  {
    name: "server", home: 26, anchor: { x: 30, z: 15.5 },
    patrol: (p) => [p],
    build() {
      box(28.5, 1.1, 16.5, 0.8, 2.2, 0.8, COLORS.serverBox);
      box(31.5, 1.1, 16.5, 0.8, 2.2, 0.8, COLORS.serverBox);
      box(28.5, 1.6, 16.05, 0.5, 0.06, 0.04, COLORS.led, true);
      box(31.5, 1.2, 16.05, 0.5, 0.06, 0.04, COLORS.led, true);
      light(30, 15.5, "on", COLD);
      loot("harddrive", 30, 16.9);
    },
  },
  {
    name: "office", home: 34, anchor: { x: 38, z: 15.5 },
    patrol: (p) => [p],
    build() {
      desk(39.8, 16.2, 1.8, 0.9); chair(39.8, 15, "s"); monitor(39.8, 16.3);
      cabinet(41.6, 13.7, false);
      papers(38.5, 14.5, 4);
      light(38, 15.5, "off");
      loot("cashbox", 41.2, 16.5);
    },
  },
];

/** Where the security card can spawn (local/home coords + resting height). */
export const KEYCARD_CARRIERS = [
  { where: "conference", x: 38.8, z: -12.6, y: 0.85 },    // on the big table
  { where: "print", x: 41.2, z: -4.9, y: 1.32 },          // on the copier
  { where: "closet:office", x: 39.4, z: 16.35, y: 0.85 }, // on the desk
  { where: "north:ward", x: -9, z: -8.9, y: 0.82 },       // on a gurney
] as const;

// slot frames
const NORTH_SLOT_X = [-18, -6, 6];                 // door nodes c_12 / c0 / c12
const NORTH_DOORS = ["c_12", "c0", "c12"];
const SOUTH_SLOT_X = [-18, 0];                     // door nodes c_9 / c9
const SOUTH_DOORS = ["c_9", "c9"];
const EAST_SLOT_X = [18, 28];                      // cor doors c22 / c33, hall sh22 / sh33
const EAST_DOORS = [
  { cor: "c22", hall: "sh22", corX: 22, hallX: 22 },
  { cor: "c33", hall: "sh33", corX: 33, hallX: 33 },
];
const CLOSET_SLOT_X = [18, 26, 34];
const CLOSET_DOORS = ["sh22", "sh30", "sh38"];

// ---------------------------------------------------------------------
// skeleton: everything that never moves
// ---------------------------------------------------------------------

function buildSkeleton() {
  // floors + ceilings
  box(0, -0.15, 0, 37, 0.3, 25, COLORS.floor);
  box(30.07, -0.15, 0, 24.45, 0.3, 36.6, COLORS.floor);
  box(0, H + 0.15, 0, 37, 0.3, 25, COLORS.ceiling);
  box(30.07, H + 0.15, 0, 24.45, 0.3, 36.6, COLORS.ceiling);

  // perimeter
  wallZ(-18, -12.3, 12.3);
  wallX(-18.3, 18, -12);
  wallX(-18.3, 18, 12);
  wallZ(18, -18.3, -12);
  wallZ(18, 12, 18.3);
  wallX(17.85, 42.3, -18);
  wallX(17.85, 42.3, 18);
  wallZ(42, -18.3, 18.3);

  // wing divider x=18: propped door, corridor double door, shutter gap
  wallZ(18, -12, -8.75);
  wallZ(18, -7.25, -1.2);
  wallZ(18, 1.2, 10.5);
  lintel(18, -8, false, 1.5);
  lintel(18, 0, false, 2.4);
  lintel(18, 11.25, false, 1.5);
  box(17.55, 1.1, -7.05, 0.9, 2.2, 0.08, COLORS.door, true);

  // west wing corridor walls
  wallX(-18, -12.8, -1.5); wallX(-11.2, -0.8, -1.5);
  wallX(0.8, 11.2, -1.5); wallX(12.8, 18, -1.5);
  lintel(-12, -1.5, true); lintel(0, -1.5, true); lintel(12, -1.5, true);
  wallX(-18, -9.8, 1.5); wallX(-8.2, 8.2, 1.5); wallX(9.8, 18, 1.5);
  lintel(-9, 1.5, true); lintel(9, 1.5, true);
  wallZ(-6, -12, -1.5); wallZ(6, -12, -1.5);
  wallZ(0, 1.5, 5.2); wallZ(0, 6.8, 12);
  lintel(0, 6, false);

  // east corridor north wall + dock
  wallX(18, 21.2, -1.5); wallX(22.8, 29.2, -1.5);
  wallX(30.8, 35.2, -1.5); wallX(36.8, 38, -1.5);
  lintel(22, -1.5, true); lintel(30, -1.5, true); lintel(36, -1.5, true);
  wallZ(38, -3, -1.5); wallZ(38, 1.5, 3);
  wallX(37.85, 42.3, -3);
  wallX(37.85, 39.2, 3); wallX(40.8, 42.3, 3);
  lintel(40, 3, true);

  // east corridor south wall
  wallX(18, 21.2, 1.5); wallX(22.8, 32.2, 1.5); wallX(33.8, 38, 1.5);
  lintel(22, 1.5, true); lintel(33, 1.5, true);

  // cubicle floor east wall + conference/print divider
  wallZ(34, -18, -12.8); wallZ(34, -11.2, -1.5);
  lintel(34, -12, false);
  wallX(34, 37.2, -8); wallX(38.8, 42, -8);
  lintel(38, -8, true);

  // east-south rooms shared walls
  wallZ(28, 1.5, 10);
  wallZ(38, 3, 10);
  wallX(18, 21.2, 10); wallX(22.8, 28, 10);
  lintel(22, 10, true);
  wallX(28, 32.2, 10); wallX(33.8, 38, 10);
  lintel(33, 10, true);

  // south hall wall + closet dividers
  wallX(18, 21.3, 13); wallX(22.7, 29.3, 13);
  wallX(30.7, 37.3, 13); wallX(38.7, 42, 13);
  lintel(22, 13, true, 1.4); lintel(30, 13, true, 1.4); lintel(38, 13, true, 1.4);
  wallZ(26, 13, 18); wallZ(34, 13, 18);

  // cubicle partitions + cells (fixed chunk)
  box(26, 0.9, -10, 12, 1.8, 0.1, COLORS.partition);
  box(26, 0.9, -8, 12, 1.8, 0.1, COLORS.partition);
  for (const x of [20, 24, 28, 32]) {
    box(x, 0.9, -12, 0.1, 1.8, 4, COLORS.partition);
    box(x, 0.9, -6, 0.1, 1.8, 4, COLORS.partition);
  }
  cubicleCell(22, -10.7, -12, "n");
  cubicleCell(26, -10.7, -12, "n");
  cubicleCell(30, -10.7, -12, "n");
  cubicleCell(22, -7.3, -6, "s");
  cubicleCell(26, -7.3, -6, "s");
  cubicleCell(30, -7.3, -6, "s");
  overturnedChair(24, -9.6);
  papers(27, -9.3, 5); papers(21, -15.5, 3);
  mug(26.4, 0.83, -7.2);
  loot("specimen", 22, -10.9);
  loot("cashbox", 26, -7.2);
  loot("harddrive", 30, -10.9);
  loot("files", 21, -15.6);
  loot("medkit", 32.8, -15.6);

  // conference (fixed chunk)
  box(38, 0.76, -13, 3.6, 0.1, 1.5, COLORS.woodLight);
  for (const [ox, oz] of [[-1.5, -0.5], [1.5, -0.5], [-1.5, 0.5], [1.5, 0.5]])
    box(38 + ox, 0.38, -13 + oz, 0.14, 0.76, 0.14, COLORS.woodLight);
  chair(36.4, -14.2, "n"); chair(38, -14.3, "n"); chair(39.6, -14.2, "n");
  chair(36.4, -11.8, "s"); chair(39.6, -11.8, "s");
  box(38, 1.7, -17.8, 2.4, 1.3, 0.08, COLORS.screen, true);
  papers(37.4, -12.9, 3, 0.83);
  loot("radio", 40.5, -16.5);
  loot("harddrive", 35.6, -10.6);
  loot("files", 36.5, -16.2);

  // print room (fixed chunk)
  box(41.2, 0.6, -5, 1.0, 1.2, 0.7, COLORS.metal);
  box(41.2, 1.24, -5, 0.9, 0.08, 0.6, COLORS.metalDark, true);
  papers(40.6, -3.2, 5);
  cabinet(41.5, -7.5, false);
  loot("files", 41, -2.5);
  loot("radio", 39.4, -6.6);

  // south hall + dock clutter
  overturnedChair(26, 11.8);
  papers(35, 12.2, 3);
  box(40, 0.12, 0, 1.6, 0.24, 1.2, COLORS.crate);

  // fixed lights
  light(-12, 0, "on"); light(0, 0, "flicker"); light(12, 0, "off");
  light(22, 0, "on"); light(30, 0, "off"); light(36, 0, "flicker");
  light(22, -9, "flicker", GREEN); light(30, -9, "off", GREEN);
  light(26, -16, "on", GREEN);
  light(38, -13, "on", WARM); light(38, -5, "flicker");
  light(26, 11.5, "off"); light(36, 11.5, "on");
  light(40, 0, "on", COLD);

  // skeleton nav
  node("cwest", -16, 0); node("c_12", -12, 0); node("c_9", -9, 0);
  node("c0", 0, 0); node("c9", 9, 0); node("c12", 12, 0); node("ceast", 16, 0);
  node("de", 0, 6); node("pdw", 16.5, -8); node("scw", 16, 11.25);
  node("c22", 22, 0); node("c30", 30, 0); node("c33", 33, 0);
  node("c36", 36, 0); node("dock", 40, 0);
  node("cwTop", 19, -2.75); node("cubS22", 22, -2.75); node("cubS30", 30, -2.75);
  node("ceTop", 33, -2.75); node("cwMid", 19, -9); node("ceMid", 33, -9);
  node("cwN", 19, -16); node("ceN", 33, -16); node("ceDoor", 33, -12);
  node("conf", 38, -12); node("prt", 38, -4.5);
  node("sh22", 22, 11.5); node("sh30", 30, 11.5); node("sh33", 33, 11.5);
  node("sh38", 38, 11.5); node("sh40", 40, 11.5); node("lk", 40, 6.5);

  edge("cwest", "c_12"); edge("c_12", "c_9"); edge("c_9", "c0");
  edge("c0", "c9"); edge("c9", "c12"); edge("c12", "ceast");
  edge("ceast", "c22"); edge("c22", "c30"); edge("c30", "c33");
  edge("c33", "c36"); edge("c36", "dock");
  edge("c22", "cubS22"); edge("c30", "cubS30");
  edge("cubS22", "cwTop"); edge("cubS22", "cubS30"); edge("cubS30", "ceTop");
  edge("cwTop", "cwMid"); edge("cwMid", "cwN"); edge("cwN", "ceN");
  edge("ceN", "ceDoor"); edge("ceDoor", "ceMid"); edge("ceMid", "ceTop");
  edge("cwMid", "ceMid");
  edge("ceDoor", "conf"); edge("c36", "prt"); edge("prt", "conf");
  edge("sh22", "sh30"); edge("sh30", "sh33"); edge("sh33", "sh38");
  edge("sh38", "sh40"); edge("sh40", "lk"); edge("lk", "dock");
}

// ---------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------

export const IDENTITY_LAYOUT: LayoutDescriptor = {
  north: [0, 1, 2],
  south: [0, 1],
  east: [0, 1],
  closets: [0, 1, 2],
  flipped: false,
  keycard: 0,
};

const dedupPush = (route: string[], id: string) => {
  if (route[route.length - 1] !== id) route.push(id);
};

export function buildLayout(desc: LayoutDescriptor): Layout {
  cur = {
    boxes: [], gateDoors: [], lights: [], navNodes: {}, navEdges: [],
    patrolRoute: [], spawnPoints: [], enemySpawn: { x: 0, z: 0 },
    extractionZone: { x: 40, z: 0, sx: 3.4, sz: 3.4 },
    keycardPos: { x: 0, z: 0, y: 0.85 }, breakerPos: { x: 0, z: 0 },
    lootCandidates: [],
  };
  curDX = 0;
  buildSkeleton();

  const chunkAt = new Map<string, string>(); // "north:ward" -> slot anchor id

  // north slots
  desc.north.forEach((chunkIdx, slot) => {
    const chunk = NORTH_CHUNKS[chunkIdx];
    curDX = NORTH_SLOT_X[slot] - chunk.home;
    const id = `n${slot}`;
    node(id, chunk.anchor.x, chunk.anchor.z);
    chunk.build(id);
    curDX = 0;
    edge(NORTH_DOORS[slot], id);
    chunkAt.set(`north:${chunk.name}`, id);
  });
  // propped door links slot n2 to the cubicle floor
  edge("n2", "pdw"); edge("pdw", "cwMid");

  // south slots
  desc.south.forEach((chunkIdx, slot) => {
    const chunk = SOUTH_CHUNKS[chunkIdx];
    curDX = SOUTH_SLOT_X[slot] - chunk.home;
    const id = `s${slot}`;
    node(id, chunk.anchor.x, chunk.anchor.z);
    chunk.build(id);
    curDX = 0;
    edge(SOUTH_DOORS[slot], id);
    chunkAt.set(`south:${chunk.name}`, id);
  });
  edge("s0", "de"); edge("de", "s1");
  edge("s1", "scw"); edge("scw", "sh22", "shortcut");

  // east slots (gate doors follow the archives chunk)
  desc.east.forEach((chunkIdx, slot) => {
    const chunk = EAST_CHUNKS[chunkIdx];
    curDX = EAST_SLOT_X[slot] - chunk.home;
    const id = `e${slot}`;
    node(id, chunk.anchor.x, chunk.anchor.z);
    chunk.build(id);
    curDX = 0;
    const doors = EAST_DOORS[slot];
    if (chunk.gated) {
      edge(doors.cor, id, "archives");
      edge(id + "Bot", doors.hall, "archives");
      cur.gateDoors.push(
        { gate: "archives", x: doors.corX, y: 1.1, z: 1.5, sx: 1.6, sy: 2.2, sz: 0.12, color: COLORS.gate },
        { gate: "archives", x: doors.corX, y: 1.1, z: 10, sx: 1.6, sy: 2.2, sz: 0.12, color: COLORS.gate }
      );
    } else {
      edge(doors.cor, id);
      edge(id, doors.hall);
    }
    chunkAt.set(`east:${chunk.name}`, id);
  });
  // the powered shutter is a skeleton feature
  cur.gateDoors.push({
    gate: "shortcut", x: 18, y: 1.1, z: 11.25, sx: 0.12, sy: 2.2, sz: 1.5, color: COLORS.gate,
  });

  // closet slots
  desc.closets.forEach((chunkIdx, slot) => {
    const chunk = CLOSET_CHUNKS[chunkIdx];
    curDX = CLOSET_SLOT_X[slot] - chunk.home;
    const id = `k${slot}`;
    node(id, chunk.anchor.x, chunk.anchor.z);
    chunk.build(id);
    curDX = 0;
    edge(CLOSET_DOORS[slot], id);
    chunkAt.set(`closet:${chunk.name}`, id);
  });

  // keycard position (follows its carrier chunk if that chunk moves)
  const carrier = KEYCARD_CARRIERS[desc.keycard] ?? KEYCARD_CARRIERS[0];
  if (carrier.where === "conference" || carrier.where === "print") {
    cur.keycardPos = { x: carrier.x, z: carrier.z, y: carrier.y };
  } else {
    const anchorId = chunkAt.get(carrier.where)!;
    const group = carrier.where.startsWith("north") ? "north" : "closet";
    const chunkList = group === "north" ? NORTH_CHUNKS : CLOSET_CHUNKS;
    const slotXs = group === "north" ? NORTH_SLOT_X : CLOSET_SLOT_X;
    const slot = Number(anchorId.slice(1));
    const chunkName = carrier.where.split(":")[1];
    const chunk = chunkList.find((c) => c.name === chunkName)!;
    const dx = slotXs[slot] - chunk.home;
    cur.keycardPos = { x: carrier.x + dx, z: carrier.z, y: carrier.y };
  }

  // spawn / extraction ends
  if (desc.flipped) {
    cur.spawnPoints = [
      { x: 40.5, z: 0 }, { x: 39.5, z: 0.9 }, { x: 39.5, z: -0.9 }, { x: 38.8, z: 0 },
    ];
    cur.extractionZone = { x: -16.5, z: 0, sx: 3, sz: 2.8 };
    cur.enemySpawn = cur.navNodes["n0"];
  } else {
    cur.spawnPoints = [
      { x: -16.5, z: 0 }, { x: -15.5, z: 0.9 }, { x: -15.5, z: -0.9 }, { x: -14.5, z: 0 },
    ];
    cur.extractionZone = { x: 40, z: 0, sx: 3.4, sz: 3.4 };
    cur.enemySpawn = cur.navNodes["n2"];
  }

  buildPatrolRoute(desc);
  const layout = cur;
  cur = undefined as any;
  return layout;
}

// corridor spine, east to west; every adjacent pair is a nav edge
const SPINE = [
  "dock", "c36", "c33", "c30", "c22", "ceast",
  "c12", "c9", "c0", "c_9", "c_12", "cwest",
];

function buildPatrolRoute(desc: LayoutDescriptor) {
  const route: string[] = [];
  const push = (...ids: string[]) => ids.forEach((id) => dedupPush(route, id));
  /** Push every spine node between `from` and `to`, inclusive. */
  const walk = (from: string, to: string) => {
    const i = SPINE.indexOf(from);
    const j = SPINE.indexOf(to);
    const s = j >= i ? 1 : -1;
    for (let k = i; k !== j + s; k += s) push(SPINE[k]);
  };

  const northVisit = (slot: number) =>
    NORTH_CHUNKS[desc.north[slot]].patrol(`n${slot}`);
  const eastVisit = (slot: number) =>
    EAST_CHUNKS[desc.east[slot]].patrol(`e${slot}`);
  const closetVisit = (slot: number) =>
    CLOSET_CHUNKS[desc.closets[slot]].patrol(`k${slot}`);
  const mntSlot = desc.east.indexOf(1); // maintenance chunk index is 1
  const eM = `e${mntSlot}`;

  // start near the enemy spawn's wing (n0's door is c_12; n2's is c12)
  if (desc.flipped) {
    push("n0");
    walk("c_12", "ceast");
  } else {
    push("n2");
    walk("c12", "ceast");
  }

  // east corridor rooms + cubicle floor ring + conference
  push("c22", ...eastVisit(0), "c22");
  push("cubS22", "cwTop", "cwMid", "cwN", "ceN", "ceDoor", "conf", "ceDoor",
    "ceMid", "ceTop", "cubS30", "c30");
  walk("c30", "c33");
  push(...eastVisit(1), "c33");
  walk("c33", "c36");
  push("prt", "c36");

  // south hall + closets. Unflipped enters via the dock link; flipped must
  // pass through the maintenance chunk (the dock end is spawn-side).
  if (!desc.flipped) {
    push("dock", "lk", "sh40", "sh38", ...closetVisit(2), "sh38", "sh33",
      "sh30", ...closetVisit(1), "sh30", "sh22", ...closetVisit(0),
      "sh22", "sh30", "sh33", "sh38", "sh40", "lk", "dock", "c36");
  } else if (mntSlot === 1) {
    push("c33", eM, "sh33", "sh38", ...closetVisit(2), "sh38", "sh33",
      "sh30", ...closetVisit(1), "sh30", "sh22", ...closetVisit(0),
      "sh22", "sh30", "sh33", eM, "c33");
  } else {
    walk("c36", "c22");
    push(eM, "sh22", ...closetVisit(0), "sh22", "sh30", ...closetVisit(1),
      "sh30", "sh33", "sh38", ...closetVisit(2), "sh38", "sh33", "sh30",
      "sh22", eM, "c22");
  }

  // west wing tour, then wrap back to the start room
  const at = desc.flipped ? (mntSlot === 1 ? "c33" : "c22") : "c36";
  walk(at, "c0");
  push(...northVisit(1), "c0", "c9");
  push("s1", "de", "s0", "de", "s1", "c9");
  if (desc.flipped) {
    walk("c9", "cwest");
    push("c_12"); // wraps c_12 -> n0
  } else {
    push("c12"); // wraps c12 -> n2
  }
  if (route[route.length - 1] === route[0]) route.pop();
  cur.patrolRoute = route;
}

