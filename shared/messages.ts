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
/** ~5.5s of continuous sprint from full. */
export const STAMINA_DRAIN_PER_S = 1 / 5.5;
/** ~3.5s walk/idle to refill from empty. */
export const STAMINA_REGEN_PER_S = 1 / 3.5;
/** After hitting 0, sprint stays locked until this much regenerates. */
export const STAMINA_MIN_SPRINT = 0.2;
/** Server-side: 2D speeds above this count as sprinting (drain + clamp). */
export const SPRINT_DETECT_SPEED = 4.2;
