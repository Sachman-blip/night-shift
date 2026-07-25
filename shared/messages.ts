// Shared protocol between client and server.
// This file must stay dependency-free: it is imported by both workspaces.

export const ROOM_NAME = "game";

/** Server -> clients state patch interval (ms). ~20hz. */
export const PATCH_RATE_MS = 50;

/** Client -> server position update interval (ms). ~20hz. */
export const MOVE_SEND_RATE_MS = 50;

export const MSG = {
  Move: "move",
  Death: "death",
  Pickup: "pickup",    // client -> server: grab nearest loot in range
  Restart: "restart",  // client -> server: start next round (from results)
  Teleport: "teleport", // server -> one client: hard reposition (round reset)
  Rtc: "rtc",          // WebRTC signaling, relayed peer-to-peer via the room
  Revive: "revive",    // client -> server: holding interact on a downed ally
  Buy: "buy",          // client -> server: purchase an upgrade between shifts
  Swap: "swap",        // client -> server: load a fresh flashlight cell
} as const;

/** Client -> server -> target client: opaque WebRTC signaling payload. */
export interface RtcRelay {
  to: string;      // target sessionId (client -> server)
  from?: string;   // sender sessionId (server -> client)
  data: unknown;   // sdp offer/answer or ICE candidate
}

/** Server -> one client: you were caught; respawn at this position. */
export interface DeathMessage {
  x: number;
  z: number;
}

export interface TeleportMessage {
  x: number;
  z: number;
}

/** Client -> server: buy one level of an upgrade. */
export interface BuyMessage {
  id: string;
}

export type RoundPhase = "active" | "ended";

export type AIState = "patrol" | "chase" | "search";

/** Shape of the enemy entry in room state, as seen by the client. */
export interface EnemyStateData {
  x: number;
  y: number;
  z: number;
  yaw: number;
  aiState: AIState;
}

export interface MoveMessage {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  torch: boolean;
  crouch: boolean;
}

/** Shape of a Player entry in room state, as seen by the client. */
export interface PlayerState {
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  torch: boolean;
  colorIndex: number;
}

export const MAX_PLAYERS = 4;
export const MAX_NAME_LENGTH = 16;

// ---- movement & stamina (client simulates for feel, server enforces) ----
export const WALK_SPEED = 3.4;
export const SPRINT_SPEED = 5.8;
/** Crouch: just under half walking pace, but nearly silent. */
export const CROUCH_SPEED = 1.55;
/** ~5.5s of continuous sprint from full. */
export const STAMINA_DRAIN_PER_S = 1 / 5.5;
/** ~3.5s walk/idle to refill from empty. */
export const STAMINA_REGEN_PER_S = 1 / 3.5;
/** After hitting 0, sprint stays locked until this much regenerates. */
export const STAMINA_MIN_SPRINT = 0.2;
/** Server-side: 2D speeds above this count as sprinting (drain + clamp). */
export const SPRINT_DETECT_SPEED = 4.2;

// ---- noise ----
// The monster's hearing radius is scaled by how loud you currently are.
// Noise is derived from the speed the SERVER observes, never from a flag the
// client sends: claiming to crouch while moving at sprint speed changes
// nothing. The crouch flag only picks the quiet tier once you are already
// slow enough for it to be true.
/** Below this observed speed you count as standing still. */
export const IDLE_DETECT_SPEED = 0.35;
/** At or below this observed speed, a crouching player gets the quiet tier. */
export const CROUCH_DETECT_SPEED = 2.2;

export const NOISE_IDLE = 0.25;
export const NOISE_CROUCH = 0.4;
export const NOISE_WALK = 1;
export const NOISE_SPRINT = 1.75;

/** A lit flashlight is a beacon: it extends how far the monster can SEE you. */
export const TORCH_VISION_SCALE = 1.35;
/** A crouched silhouette is harder to pick out at range. */
export const CROUCH_VISION_SCALE = 0.62;

/**
 * Noise tier for an observed 2D speed. Shared so the client can show an
 * honest meter and the server can enforce the same number.
 */
export function noiseForSpeed(speed: number, crouching: boolean): number {
  if (speed < IDLE_DETECT_SPEED) return NOISE_IDLE;
  if (crouching && speed <= CROUCH_DETECT_SPEED) return NOISE_CROUCH;
  if (speed > SPRINT_DETECT_SPEED) return NOISE_SPRINT;
  return NOISE_WALK;
}

// ---- flashlight battery ----
/** A full cell burns for this long with the torch held on. */
export const BATTERY_SECONDS = 240;
export const BATTERY_DRAIN_PER_S = 1 / BATTERY_SECONDS;
/** Below this the beam browns out and stutters. */
export const BATTERY_LOW = 0.18;
/** Spare cells everyone carries before any shop upgrade. */
export const BASE_CELLS = 1;

// ---- downed & revive ----
export const REVIVE_RADIUS = 2.0;
/** Seconds a teammate must hold interact to bring you back up. */
export const REVIVE_SECONDS = 4;
/** Revive progress decays this fast when nobody is working on you. */
export const REVIVE_DECAY_PER_S = 0.5;
/** How long you have on the floor before the building takes you. */
export const BLEED_OUT_SECONDS = 45;
/** Bleeding out costs the whole crew this much round time. */
export const BLEED_TIME_PENALTY = 20;
/** Invulnerability granted on being helped back to your feet. */
export const REVIVE_INVULN_MS = 3000;
