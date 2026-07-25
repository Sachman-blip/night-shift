// Loot type definitions, round tuning, and the between-shift upgrade shop.
// Spawn POSITIONS are not static: each chunk contributes candidates
// (shared/map.ts) and the server picks a spread-constrained set per layout
// (server/src/layout.ts).

export interface LootTypeDef {
  label: string;
  color: number;
  /** What one of these is worth toward the quota — and to the crew's credit. */
  value: number;
}

// Values are the whole reason to choose one room over another: the archives
// jackpot is worth the keycard detour, a stack of case files is not worth
// dying for.
export const LOOT_TYPES: Record<string, LootTypeDef> = {
  files:      { label: "CASE FILES", color: 0xc9b46a, value: 1 },
  medkit:     { label: "MEDKIT",     color: 0xd8d8d0, value: 2 },
  radio:      { label: "RADIO",      color: 0x2f5d8a, value: 2 },
  typewriter: { label: "TYPEWRITER", color: 0x3d4a52, value: 3 },
  harddrive:  { label: "HARD DRIVE", color: 0x8a6a9e, value: 3 },
  cashbox:    { label: "CASH",       color: 0x3f6b3f, value: 4 },
  specimen:   { label: "SPECIMEN",   color: 0x64c48a, value: 5 },
};

export const lootValue = (kind: string): number => LOOT_TYPES[kind]?.value ?? 1;

/** Resting height for loot on the ground (client adds a small hover-bob). */
export const LOOT_GROUND_Y = 0.35;

/** Baseline slots on your back; the cargo rig upgrade adds more. */
export const CARRY_CAPACITY = 3;
export const PICKUP_RADIUS = 1.6;

export const ROUND_SECONDS = 360;

// Round scaling by player count, decided at round start: solo runs are
// shorter and lighter; a crew gets the full haul job. `quota` is a VALUE
// target, not an item count.
export interface RoundMode {
  loot: number;
  quota: number;
  seconds: number;
}
export const SOLO_MODE: RoundMode = { loot: 15, quota: 24, seconds: 360 };
export const MULTI_MODE: RoundMode = { loot: 22, quota: 44, seconds: 600 };

// ---- escalating shift progression ----
/** Every layout offers exactly this many loot spots; nothing can ask for more. */
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
 * higher value quota, less time, and — every second shift — another monster,
 * up to MAX_ENEMIES. The caller clamps quota to the value actually on the
 * map, and loot never exceeds the layout's candidate ceiling, so the plan
 * stays feasible however far a crew pushes.
 */
export function planShift(
  shift: number,
  mode: RoundMode,
  baseEnemies: number
): ShiftPlan {
  const tier = Math.max(0, Math.floor(shift) - 1);
  const loot = Math.min(MAX_LOOT, mode.loot + tier * 2);
  const quota = mode.quota + tier * 5;
  const seconds = Math.max(MIN_SECONDS, mode.seconds - tier * 20);
  const enemies = Math.min(MAX_ENEMIES, baseEnemies + Math.floor(tier / 2));
  return { loot, quota, seconds, enemies };
}

// ---- credits & the between-shift shop ----

/** Share of the shift's banked value that comes back as spendable credit. */
export const CREDIT_SHARE = 0.4;
/** Flat bonus for actually clearing the quota. */
export const CLEAR_BONUS = 8;

/** Credits earned by a finished round. A failed shift still pays something. */
export function creditsEarned(bankedValue: number, win: boolean): number {
  return Math.floor(bankedValue * CREDIT_SHARE) + (win ? CLEAR_BONUS : 0);
}

export interface UpgradeDef {
  id: string;
  label: string;
  blurb: string;
  /** Rising cost per level; length is the max level. */
  costs: number[];
}

// Upgrades are bought by the crew, not the individual: this is a co-op game
// and splitting the economy four ways just makes everyone poorer.
export const UPGRADES: UpgradeDef[] = [
  { id: "capacity", label: "CARGO RIG",    blurb: "+1 carry slot",        costs: [14, 24] },
  { id: "boots",    label: "SOFT SOLES",   blurb: "-22% noise",           costs: [12, 20] },
  { id: "lungs",    label: "CONDITIONING", blurb: "+33% sprint time",     costs: [12, 20] },
  { id: "cells",    label: "SPARE CELLS",  blurb: "+1 flashlight cell",   costs: [8, 12, 18] },
];

export const upgradeById = (id: string): UpgradeDef | undefined =>
  UPGRADES.find((u) => u.id === id);

/** Cost of moving from `level` to `level + 1`, or null if maxed. */
export function upgradeCost(id: string, level: number): number | null {
  const def = upgradeById(id);
  if (!def || level >= def.costs.length) return null;
  return def.costs[level];
}

export const carryCapacityFor = (level: number) => CARRY_CAPACITY + level;
export const noiseScaleFor = (level: number) => Math.pow(0.78, level);
export const staminaDrainScaleFor = (level: number) => Math.pow(0.75, level);
