// Mobile input verification: emulates a touch device (phone-landscape
// viewport, touch events), then proves the virtual controls actually
// drive the game — movement, look, sprint-at-rim, torch button — by
// reading the synced server state.
//
//   node tools/touch-test.mjs
// Requires: game server on :2567, vite dev server on :5173.

import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, label) {
  if (!cond) throw new Error(`assert failed: ${label}`);
  console.log(`  ok: ${label}`);
}

mkdirSync("screenshots", { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: ["--window-size=900,480"],
  defaultViewport: { width: 850, height: 390, hasTouch: true, isMobile: true },
});

try {
  const page = await browser.newPage();
  await page.goto("http://localhost:5173/?debug=1&touch=1", { waitUntil: "networkidle2" });

  await page.tap("#nameInput");
  await page.type("#nameInput", "THUMB");
  await page.tap("#createBtn");
  await page.waitForFunction(() => window.__game !== undefined, { timeout: 30000 });
  await sleep(1200);

  const state = () =>
    page.evaluate(() => {
      const r = window.__game.room;
      const p = r.state.players.get(r.sessionId);
      return { x: p.x, z: p.z, yaw: p.yaw, torch: p.torch, stamina: p.stamina };
    });

  // 1. touch UI is active
  const uiVisible = await page.evaluate(
    () => !document.getElementById("touchUI").classList.contains("hidden")
  );
  assert(uiVisible, "touch UI visible");

  // 2. joystick drag moves the player (held forward for 2s at walk deflection)
  // face down the corridor first, or "forward" walks into the north wall
  const p0 = await state();
  await page.evaluate(
    (pos, yaw) => window.__game.setView(pos.x, 1.05, pos.z, yaw, 0),
    p0,
    p0.x < 10 ? -Math.PI / 2 : Math.PI / 2
  );
  await sleep(300);
  const stick = await page.touchscreen.touchStart(170, 300);
  await stick.move(170, 265); // ~0.58 deflection: walk
  await sleep(2000);
  const p1 = await state();
  const walked = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  assert(walked > 2, `joystick moves player (${walked.toFixed(1)}m in 2s)`);

  // 3. rim deflection sprints (faster + stamina drains)
  await stick.move(170, 235); // ~1.0 deflection: sprint
  await sleep(2000);
  const p2 = await state();
  const sprinted = Math.hypot(p2.x - p1.x, p2.z - p1.z);
  await stick.end();
  assert(sprinted > walked * 1.3, `rim deflection sprints (${sprinted.toFixed(1)}m vs ${walked.toFixed(1)}m)`);
  assert(p2.stamina < 0.9, `sprint drained stamina (${p2.stamina.toFixed(2)})`);

  // 4. right-side drag turns the camera (yaw syncs to server)
  const look = await page.touchscreen.touchStart(650, 180);
  await look.move(540, 180);
  await look.end();
  await sleep(300);
  const p3 = await state();
  assert(Math.abs(p3.yaw - p2.yaw) > 0.3, `look drag changes yaw (${p2.yaw.toFixed(2)} -> ${p3.yaw.toFixed(2)})`);

  // 5. torch button toggles the synced flashlight state
  await page.tap("#btnTorch");
  await sleep(300);
  assert((await state()).torch === false, "LIGHT button toggles torch off");
  await page.tap("#btnTorch");
  await sleep(300);
  assert((await state()).torch === true, "LIGHT button toggles torch back on");

  await page.screenshot({ path: "screenshots/5-mobile-hud.png" });
  console.log("TOUCH TEST PASS (screenshot: screenshots/5-mobile-hud.png)");
} finally {
  await browser.close();
}
process.exit(0);
