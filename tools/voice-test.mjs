// Real-browser WebRTC voice test: two tabs with fake mics (Chrome test
// flags auto-grant permission and feed a tone), same room, then assert:
// peer connection reaches "connected", proximity gain tracks distance,
// mute toggles, and closing one tab cleans up without breaking the other.
//
//   node tools/voice-test.mjs

import puppeteer from "puppeteer-core";
import { Client } from "colyseus.js";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, label) {
  if (!cond) throw new Error(`assert failed: ${label}`);
  console.log(`  ok: ${label}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: [
    "--window-size=1200,700",
    "--use-fake-ui-for-media-stream",     // auto-grant mic permission
    "--use-fake-device-for-media-stream", // fake mic produces a test tone
    "--autoplay-policy=no-user-gesture-required",
  ],
  defaultViewport: { width: 1100, height: 620 },
});

// host from node: no enemy to eat the test players, freeMove so their
// teleports sync to the server instantly
const host = await new Client("ws://localhost:2567").create("game", {
  name: "HOST", noEnemy: true, freeMove: true,
});
host.send("move", { x: -12, y: 1.05, z: -6.75, yaw: 0, pitch: 0, torch: false });
const code = host.roomId;

try {
  const p1 = await browser.newPage();
  await p1.goto(`http://localhost:5173/?debug=1&join=${code}`, { waitUntil: "networkidle2" });
  await p1.waitForFunction(() => window.__game !== undefined, { timeout: 30000 });
  await p1.click("canvas"); // gesture: unlock audio contexts

  const p2 = await browser.newPage();
  await p2.goto(`http://localhost:5173/?debug=1&join=${code}`, { waitUntil: "networkidle2" });
  await p2.waitForFunction(() => window.__game !== undefined, { timeout: 30000 });
  await p2.bringToFront();
  await p2.click("canvas");
  await sleep(5000); // signaling + ICE

  const dbg = (p) => p.evaluate(() => window.__game.voice.debug());
  const sid = (p) => p.evaluate(() => window.__game.room.sessionId);
  const id1 = await sid(p1);
  const id2 = await sid(p2);

  // 1. mesh connected both ways, mics live (the node host has no WebRTC —
  // its pair correctly stays unconnected without affecting the tabs)
  const d1 = await dbg(p1);
  const d2 = await dbg(p2);
  const peer1 = d1.peers[id2];
  const peer2 = d2.peers[id1];
  console.log("  d1:", JSON.stringify(d1));
  console.log("  d2:", JSON.stringify(d2));
  assert(d1.mic === "live" && d2.mic === "live", "both mics live (fake devices)");
  assert(peer1?.conn === "connected", `tab1 -> tab2 RTC connected (${peer1?.conn})`);
  assert(peer2?.conn === "connected", `tab2 -> tab1 RTC connected (${peer2?.conn})`);

  // 2. proximity: teleport tab2's player next to tab1's, gain ~1
  const pos1 = await p1.evaluate(() => {
    const r = window.__game.room;
    const p = r.state.players.get(r.sessionId);
    return { x: p.x, z: p.z };
  });
  await p2.evaluate((v) => window.__game.setView(v.x + 1.5, 1.05, v.z, 0, 0), pos1);
  await sleep(1500);
  const nearGain = (await dbg(p1)).peers[id2].gain;
  assert(nearGain > 0.8, `near gain ~1 (${nearGain.toFixed(2)} at 1.5m)`);

  // fake mic emits a tone -> speaking indicator should trip at close range
  const speaking = (await dbg(p1)).peers[id2].speaking;
  console.log(`  info: speaking flag at close range = ${speaking} (fake tone)`);

  // 3. move far: gain silent past max range (freeMove syncs instantly)
  await p2.evaluate((v) => window.__game.setView(v.x + 30, 1.05, v.z, 0, 0), pos1);
  await sleep(2000);
  const farGain = (await dbg(p1)).peers[id2].gain;
  assert(farGain < 0.05, `far gain ~0 (${farGain.toFixed(3)} at 30m)`);

  // 4. mute toggle
  await p1.evaluate(() => window.__game.voice.toggleMute());
  assert((await dbg(p1)).mic === "muted", "mute toggles to muted");
  await p1.evaluate(() => window.__game.voice.toggleMute());
  assert((await dbg(p1)).mic === "live", "mute toggles back to live");

  // 5. tab2 closes: tab1 cleans up that peer, keeps running
  await p2.close();
  await sleep(2500);
  const after = await dbg(p1);
  assert(!(id2 in after.peers), "departed peer cleaned up");
  const alive = await p1.evaluate(() => window.__game.getFps().avg > 0);
  assert(alive, "tab1 still rendering after peer left");

  console.log("VOICE BROWSER TEST PASS");
  await host.leave();
} finally {
  await browser.close();
}
process.exit(0);
