// Close-up verification shots of the new humanoid remote players:
//   human-front — 3 bots facing the camera at 3m (visors, tags, proportions)
//   human-walk  — one bot walking across frame (limb swing mid-stride)
// Requires: game server on :2567, vite dev on :5173.

import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { Client } from "colyseus.js";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT = "screenshots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: ["--window-size=1600,940", "--autoplay-policy=no-user-gesture-required"],
  defaultViewport: { width: 1536, height: 864 },
});

try {
  const page = await browser.newPage();
  await page.goto("http://localhost:5173/?debug=1", { waitUntil: "networkidle2" });
  await page.type("#nameInput", "CAM");
  await page.click("#createBtn");
  await page.waitForFunction(() => window.__game !== undefined, { timeout: 30000 });
  await sleep(1000);
  const code = await page.$eval("#roomCode", (el) => el.textContent.trim());
  console.log(`room ${code} up, joining bots...`);

  const bots = [];
  for (const name of ["DINO", "MOTH", "WASP"]) {
    const room = await new Client("ws://localhost:2567").joinById(code, { name });
    bots.push(room);
  }
  await sleep(600);

  const spawn = await page.evaluate(() => {
    const p = window.__game.room.state.players.get(window.__game.room.sessionId);
    return { x: p.x, z: p.z };
  });
  // yaw convention: forward = (-sin yaw, -cos yaw); +PI/2 = west(-x), -PI/2 = east(+x)
  const westSpawn = spawn.x < 10;
  const camYaw = westSpawn ? Math.PI / 2 : -Math.PI / 2;   // look at the squad
  const botYaw = westSpawn ? -Math.PI / 2 : Math.PI / 2;   // squad faces camera
  const camX = westSpawn ? spawn.x + 3.2 : spawn.x - 3.2;

  // line the bots up shoulder to shoulder facing the camera
  const lineup = [spawn.z - 1.1, spawn.z, spawn.z + 1.1];
  const park = setInterval(() => {
    bots.forEach((room, i) => {
      const p = room.state.players?.get?.(room.sessionId);
      if (p) room.send("move", { x: spawn.x, y: 1.05, z: lineup[i], yaw: botYaw, pitch: 0, torch: false });
    });
  }, 100);

  await page.evaluate((v) => window.__game.setView(...v), [camX, 1.05, spawn.z, camYaw, -0.02]);
  await sleep(2500);
  await page.screenshot({ path: `${OUT}/human-front.png` });
  console.log("  human-front done");
  clearInterval(park);

  // walk WASP across the frame (north->south through spawn) and shoot mid-stride
  const walker = bots[2];
  let wz = spawn.z - 2.2;
  const stride = setInterval(() => {
    wz += 0.34; // 3.4 m/s at 10hz — walk speed
    const p = walker.state.players?.get?.(walker.sessionId);
    if (p) walker.send("move", { x: spawn.x, y: 1.05, z: wz, yaw: Math.PI, pitch: 0, torch: false });
  }, 100);
  // keep the other two parked
  const park2 = setInterval(() => {
    bots.slice(0, 2).forEach((room, i) => {
      const p = room.state.players?.get?.(room.sessionId);
      if (p) room.send("move", { x: spawn.x, y: 1.05, z: lineup[i], yaw: botYaw, pitch: 0, torch: false });
    });
  }, 100);
  await sleep(700);
  await page.screenshot({ path: `${OUT}/human-walk-a.png` });
  await sleep(450);
  await page.screenshot({ path: `${OUT}/human-walk-b.png` });
  console.log("  human-walk done");
  clearInterval(stride);
  clearInterval(park2);

  for (const room of bots) await room.leave();
  console.log("DONE");
} finally {
  await browser.close();
}
process.exit(0);
