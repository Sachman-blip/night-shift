// Voice signaling relay test. Run while the server is up:
//   npm run smoke:voice -w server
// Verifies the Colyseus room relays opaque RTC payloads between the right
// peers, tags the sender, and ignores junk. (Real WebRTC audio is covered
// by tools/voice-test.mjs in a real browser.)

import { Client, type Room } from "colyseus.js";
import { ROOM_NAME, MSG } from "../../shared/messages";

const ENDPOINT = process.env.ENDPOINT ?? "ws://localhost:2567";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(cond: unknown, label: string) {
  if (!cond) throw new Error(`assert failed: ${label}`);
  console.log(`  ok: ${label}`);
}

async function main() {
  const a = await new Client(ENDPOINT).create(ROOM_NAME, { name: "A", noEnemy: true });
  const b = await new Client(ENDPOINT).joinById(a.roomId, { name: "B" });
  const c = await new Client(ENDPOINT).joinById(a.roomId, { name: "C" });
  await sleep(300);

  const got: Record<string, any[]> = { a: [], b: [], c: [] };
  a.onMessage(MSG.Rtc, (m) => got.a.push(m));
  b.onMessage(MSG.Rtc, (m) => got.b.push(m));
  c.onMessage(MSG.Rtc, (m) => got.c.push(m));

  // targeted relay: A -> B only
  a.send(MSG.Rtc, { to: b.sessionId, data: { sdp: { type: "offer", fake: 1 } } });
  await sleep(250);
  assert(got.b.length === 1, "target received exactly one relay");
  assert(got.b[0].from === a.sessionId, "relay tagged with sender sessionId");
  assert(got.b[0].data?.sdp?.fake === 1, "payload passed through opaque");
  assert(got.c.length === 0, "third peer received nothing");

  // reply path: B -> A
  b.send(MSG.Rtc, { to: a.sessionId, data: { candidate: { x: 2 } } });
  await sleep(250);
  assert(got.a.length === 1 && got.a[0].from === b.sessionId, "reply relayed back");

  // junk resilience: bogus target / malformed payloads must not crash
  a.send(MSG.Rtc, { to: "nope-not-real", data: { sdp: 1 } });
  a.send(MSG.Rtc, { data: { sdp: 1 } } as any);
  a.send(MSG.Rtc, null as any);
  await sleep(250);
  a.send(MSG.Rtc, { to: c.sessionId, data: { ok: true } });
  await sleep(250);
  assert(got.c.length === 1 && got.c[0].data?.ok, "relay still works after junk input");

  // leaver: relays to a departed peer are dropped silently
  await b.leave();
  await sleep(200);
  a.send(MSG.Rtc, { to: b.sessionId, data: { late: 1 } });
  await sleep(250);
  a.send(MSG.Rtc, { to: c.sessionId, data: { ok: 2 } });
  await sleep(250);
  assert(got.c.length === 2, "relay unaffected after a peer left");

  console.log("VOICE RELAY SMOKE TEST PASS");
  await a.leave();
  await c.leave();
  process.exit(0);
}

main().catch((err) => {
  console.error("VOICE RELAY SMOKE TEST FAIL:", err);
  process.exit(1);
});
