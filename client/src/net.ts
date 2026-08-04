import { Client, type Room } from "colyseus.js";
import { ROOM_NAME } from "../../shared/messages";

// Same-host by default so LAN playtesting works out of the box;
// override with VITE_SERVER_URL for a deployed server.
const CONFIGURED = import.meta.env.VITE_SERVER_URL as string | undefined;
const ENDPOINT = CONFIGURED ?? `ws://${location.hostname}:2567`;

const client = new Client(ENDPOINT);

// The deployed server sits on a free tier that idles the process out after a
// few minutes and only restarts it when an HTTP request lands. That boot takes
// the better part of a minute, which every socket connect and matchmaking POST
// gives up on well before. So knock on the plain /health route first and keep
// knocking until it answers — the first join of the evening is slow, but it is
// a wait with a message rather than "can't reach the server".
//
// Only when a remote server is configured: on localhost a refused connection
// means the dev server genuinely is not running, and failing instantly is the
// useful answer there.
const HEALTH_URL =
  ENDPOINT.replace(/^ws/, "http").replace(/\/+$/, "") + "/health";
const WAKE_TIMEOUT_MS = 90_000;
const WAKE_RETRY_MS = 2_000;

export async function wakeServer(
  onWaiting: (secondsElapsed: number) => void
): Promise<void> {
  if (!CONFIGURED) return;

  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < WAKE_TIMEOUT_MS) {
    try {
      const res = await fetch(HEALTH_URL, { cache: "no-store" });
      if (res.ok) return;
      lastError = new Error(`health check returned ${res.status}`);
    } catch (err) {
      lastError = err; // still cold, or genuinely unreachable — keep knocking
    }
    onWaiting(Math.round((Date.now() - startedAt) / 1000));
    await new Promise((r) => setTimeout(r, WAKE_RETRY_MS));
  }
  console.error("[net] server never woke up:", lastError);
  throw new Error("the server is taking too long to wake up — try again");
}

export function createRoom(name: string): Promise<Room> {
  return client.create(ROOM_NAME, { name });
}

export function joinRoom(code: string, name: string): Promise<Room> {
  return client.joinById(code.trim().toUpperCase(), { name });
}
