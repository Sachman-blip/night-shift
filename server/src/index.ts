import { Server } from "colyseus";
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
// Railway's ALWAYS restart policy still covers hard crashes.
process.on("uncaughtException", (err) => {
  console.error("[server] uncaught exception (kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled rejection (kept alive):", reason);
});

const port = Number(process.env.PORT ?? 2567);

const gameServer = new Server();
gameServer.define(ROOM_NAME, GameRoom);

gameServer.listen(port).then(() => {
  console.log(`[server] listening on ws://localhost:${port}`);
});
