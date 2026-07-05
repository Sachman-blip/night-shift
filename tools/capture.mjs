// Screenshot + FPS capture: drives the real game in a headed Chrome (real
// GPU), joins 3 bot clients for a 4-player render load, grabs shots at
// fixed viewpoints via the ?debug=1 hooks, and reads the rolling FPS probe.
//
//   node tools/capture.mjs
//
// Requires: game server on :2567, vite dev server on :5173.

import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { Client } from "colyseus.js";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT = "screenshots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false, // headed = real GPU = honest FPS numbers
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
  console.log(`room ${code} up, joining 3 bots...`);

  // Bots: join, then idle at their assigned spawns with torches on so the
  // main view renders 3 remote players + 3 extra shadowless spotlights.
  const bots = [];
  for (const name of ["DINO", "MOTH", "WASP"]) {
    const room = await new Client("ws://localhost:2567").joinById(code, { name });
    bots.push(room);
  }
  await sleep(500);
  // read own spawn from state and just re-assert it (keeps them "moving")
  const keepAlive = setInterval(() => {
    for (const room of bots) {
      const p = room.state.players?.get?.(room.sessionId);
      if (p) {
        room.send("move", {
          x: p.x + (Math.random() - 0.5) * 0.1,
          y: 1.05,
          z: p.z + (Math.random() - 0.5) * 0.1,
          yaw: Math.random() * 6.28,
          pitch: 0,
          torch: true,
        });
      }
    }
  }, 100);

  // figure out where spawn is from the camera player's own state
  const spawn = await page.evaluate(() => {
    const p = window.__game.room.state.players.get(window.__game.room.sessionId);
    return { x: p.x, z: p.z };
  });
  // yaw convention: forward = (-sin yaw, -cos yaw); 0 = north(-z),
  // PI = south(+z), -PI/2 = east(+x), +PI/2 = west(-x)
  const westSpawn = spawn.x < 10;

  const shots = [
    {
      // stand INSIDE the corridor next to spawn, facing the squad
      name: "1-squad-at-spawn",
      view: westSpawn
        ? [spawn.x + 6, 1.05, spawn.z, Math.PI / 2, -0.02]   // look west at them
        : [spawn.x - 6, 1.05, spawn.z, -Math.PI / 2, -0.02], // look east at them
      note: "4-player load: 3 teammates + torches in frame",
    },
    {
      name: "2-corridor-beacon",
      view: westSpawn ? [8, 1.05, 0, -Math.PI / 2, 0] : [30, 1.05, 0, Math.PI / 2, 0],
      note: "long corridor look toward the extraction beacon",
    },
    {
      name: "3-cubicle-floor",
      view: [26, 1.05, -2.9, 0, -0.05], // south lane, looking north into the cells
      note: "cubicle rows, flashlight shadows off partitions",
    },
    {
      name: "4-north-room",
      view: [12, 1.05, -3.0, 0, -0.08], // inside the n2 room, looking north
      note: "north room interior",
    },
  ];

  const fpsReadings = [];
  for (const shot of shots) {
    await page.evaluate((v) => window.__game.setView(...v), shot.view);
    await sleep(2500); // let flickers settle + FPS window refill
    const fps = await page.evaluate(() => window.__game.getFps());
    fpsReadings.push({ name: shot.name, ...fps });
    await page.screenshot({ path: `${OUT}/${shot.name}.png` });
    console.log(`  ${shot.name}: avg ${fps.avg} fps (1%-low ~${fps.low}) — ${shot.note}`);
  }

  clearInterval(keepAlive);
  for (const room of bots) await room.leave();
  console.log("CAPTURE DONE");
  console.log(JSON.stringify(fpsReadings));
} finally {
  await browser.close();
}
process.exit(0);
