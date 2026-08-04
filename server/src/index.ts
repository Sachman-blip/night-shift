import { createServer } from "http";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./rooms/GameRoom";
import { generateLayout } from "./layout";
import { IDENTITY_LAYOUT } from "../../shared/map";
import { ROOM_NAME } from "../../shared/messages";

// Crash at boot, not mid-match, if chunks/skeleton/nav have drifted:
// the identity arrangement plus a handful of random ones must validate.
generateLayout(IDENTITY_LAYOUT);
for (let i = 0; i < 5; i++) generateLayout();
console.log("[server] layout self-test passed");

// Stay-alive safety net: a bug in one room tick shouldn't take the whole
// server (and every other room) down. Log it loudly and keep serving —
// the host's restart policy still covers hard crashes.
process.on("uncaughtException", (err) => {
  console.error("[server] uncaught exception (kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled rejection (kept alive):", reason);
});

const port = Number(process.env.PORT ?? 2567);

// The default transport only ever answers WebSocket upgrades, so a plain GET
// hangs forever. Free hosts idle the process out and restart it on the next
// inbound HTTP request — a cold boot runs close to a minute, far longer than
// either a socket connect or a matchmaking POST will wait. Serving one cheap
// route the client can poll turns "can't reach the server" into a slow join,
// and gives the host something real to health-check.
//
// Colyseus re-wires this listener rather than replacing it: attachMatchMakingRoutes
// preserves handlers already on the server and only intercepts /matchmake.
const httpServer = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    res.writeHead(200, {
      "content-type": "application/json",
      // the client is served from another origin (Vercel), so the wake-up
      // probe is cross-origin and needs this to be readable
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ ok: true, rooms: ROOM_NAME }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});
gameServer.define(ROOM_NAME, GameRoom);

gameServer.listen(port).then(() => {
  console.log(`[server] listening on ws://localhost:${port}`);
});
