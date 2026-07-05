import { Client, type Room } from "colyseus.js";
import { ROOM_NAME } from "../../shared/messages";

// Same-host by default so LAN playtesting works out of the box;
// override with VITE_SERVER_URL for a deployed server.
const ENDPOINT =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  `ws://${location.hostname}:2567`;

const client = new Client(ENDPOINT);

export function createRoom(name: string): Promise<Room> {
  return client.create(ROOM_NAME, { name });
}

export function joinRoom(code: string, name: string): Promise<Room> {
  return client.joinById(code.trim().toUpperCase(), { name });
}
