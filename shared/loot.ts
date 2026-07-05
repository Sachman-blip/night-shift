// Loot type definitions and round tuning. Spawn POSITIONS are no longer
// static: each chunk contributes candidates (shared/map.ts) and the server
// picks a spread-constrained set per layout (server/src/layout.ts).

export interface LootTypeDef {
  label: string;
  color: number;
}

export const LOOT_TYPES: Record<string, LootTypeDef> = {
  files:      { label: "CASE FILES", color: 0xc9b46a },
  typewriter: { label: "TYPEWRITER", color: 0x3d4a52 },
  radio:      { label: "RADIO",      color: 0x2f5d8a },
  cashbox:    { label: "CASH",       color: 0x3f6b3f },
  medkit:     { label: "MEDKIT",     color: 0xd8d8d0 },
  specimen:   { label: "SPECIMEN",   color: 0x64c48a },
  harddrive:  { label: "HARD DRIVE", color: 0x8a6a9e },
};

/** Resting height for loot on the ground (client adds a small hover-bob). */
export const LOOT_GROUND_Y = 0.35;

export const CARRY_CAPACITY = 3;
export const PICKUP_RADIUS = 1.6;

export const ROUND_SECONDS = 360;

// Round scaling by player count, decided at round start:
// solo runs are shorter and lighter; a crew gets the full haul job.
export interface RoundMode {
  loot: number;
  quota: number;
  seconds: number;
}
export const SOLO_MODE: RoundMode = { loot: 15, quota: 10, seconds: 360 };
export const MULTI_MODE: RoundMode = { loot: 22, quota: 20, seconds: 600 };

// ---- escalating shift progression ----
// Every layout offers exactly this many loot spots; nothing can ask for more.
export const MAX_LOOT = 26;
/** One monster per variant is the ceiling (see ENEMY_VARIANTS). */
export const MAX_ENEMIES = 3;
/** No shift drops below this, however deep the run goes. */
export const MIN_SECONDS = 120;

export interface ShiftPlan {
  loot: number;
  quota: number;
  seconds: number;
  enemies: number;
}

/**
 * Difficulty for shift `n` (1-based), escalating on top of the player-count
 * mode. Each cleared shift ratchets the next one up: more loot to sweep, a
 * higher quota, less time, and — every second shift — another monster, up to
 * MAX_ENEMIES. Quota can never exceed the loot actually on the map, and loot
 * never exceeds the layout's candidate ceiling, so the plan stays feasible
 * however far a crew pushes.
 */
export function planShift(
  shift: number,
  mode: RoundMode,
  baseEnemies: number
): ShiftPlan {
  const tier = Math.max(0, Math.floor(shift) - 1);
  const loot = Math.min(MAX_LOOT, mode.loot + tier * 2);
  const quota = Math.min(loot, mode.quota + tier * 2);
  const seconds = Math.max(MIN_SECONDS, mode.seconds - tier * 20);
  const enemies = Math.min(MAX_ENEMIES, baseEnemies + Math.floor(tier / 2));
  return { loot, quota, seconds, enemies };
}
