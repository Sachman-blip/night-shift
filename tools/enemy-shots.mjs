// Per-variant enemy screenshots: for each monster type, create a pinned
// room, join it in Chrome, park the camera near the enemy (behind its
// vision cone, outside hearing) for a PATROL shot, then step in front to
// trigger CHASE and shoot again. Also reports FPS with the animated model.
//
//   node tools/enemy-shots.mjs

import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { Client } from "colyseus.js";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync("screenshots", { recursive: true });

const IDENTITY = {
  north: [0, 1, 2], south: [0, 1], east: [0, 1],
  closets: [0, 1, 2], flipped: false, keycard: 0,
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: ["--window-size=1600,940"],
  defaultViewport: { width: 1536, height: 864 },
});

const fpsLog = [];
try {
  for (const variant of ["stalker", "listener", "sprinter"]) {
    // host the room from node so we can pin layout + variant
    const host = await new Client("ws://localhost:2567").create("game", {
      name: "HOST", layout: IDENTITY, variant, enemies: 1, freeMove: true,
    });
    // park the host far away so it never distracts the enemy
    host.send("move", { x: -12, y: 1.05, z: -6.75, yaw: 0, pitch: 0, torch: false });

    const page = await browser.newPage();
    await page.goto("http://localhost:5173/?debug=1", { waitUntil: "networkidle2" });
    await page.type("#nameInput", "CAM");
    await page.type("#codeInput", host.roomId);
    await page.click("#joinBtn");
    await page.waitForFunction(() => window.__game !== undefined, { timeout: 30000 });
    await sleep(800);

    const enemy = () =>
      page.evaluate(() => {
        const e = window.__game.room.state.enemies.get("e0");
        return { x: e.x, z: e.z, yaw: e.yaw, state: e.aiState };
      });

    // PATROL: hover camera BEHIND the enemy, 5m back (outside hearing=4,
    // outside the forward vision cone), looking at it
    let e = await enemy();
    const bx = e.x + Math.sin(e.yaw) * 5;   // behind = -forward = (+sin, +cos)
    const bz = e.z + Math.cos(e.yaw) * 5;
    const lookYaw = Math.atan2(-(e.x - bx), -(e.z - bz));
    await page.evaluate((v) => window.__game.setView(...v), [bx, 1.35, bz, lookYaw, -0.05]);
    await sleep(1400);
    // re-aim once (it patrols away from us)
    e = await enemy();
    const yaw2 = Math.atan2(-(e.x - bx), -(e.z - bz));
    await page.evaluate((v) => window.__game.setView(...v), [bx, 1.35, bz, yaw2, -0.05]);
    await sleep(200);
    await page.screenshot({ path: `screenshots/enemy-${variant}-patrol.png` });

    // CHASE: the freeMove host baits 3m in front of its face; the camera
    // watches side-on from 4.5m, outside the kill path
    e = await enemy();
    const fx = e.x - Math.sin(e.yaw) * 5.5;
    const fz = e.z - Math.cos(e.yaw) * 5.5;
    host.send("move", { x: fx, y: 1.05, z: fz, yaw: 0, pitch: 0, torch: true });
    const px = e.x + Math.cos(e.yaw) * 4.5;
    const pz = e.z - Math.sin(e.yaw) * 4.5;
    const tx = e.x - Math.sin(e.yaw) * 3; const tz = e.z - Math.cos(e.yaw) * 3; const camYaw = Math.atan2(-(tx - px), -(tz - pz));
    await page.evaluate((v) => window.__game.setView(...v), [px, 1.35, pz, camYaw, -0.05]);
    await sleep(520); // chase pose ramps; host takes the hit, not the camera
    const st = (await enemy()).state;
    await page.screenshot({ path: `screenshots/enemy-${variant}-chase.png` });
    const fps = await page.evaluate(() => window.__game.getFps());
    fpsLog.push({ variant, chaseState: st, ...fps });
    console.log(`  ${variant}: chase-state=${st} avg ${fps.avg} fps (low ~${fps.low})`);

    await page.close();
    await host.leave();
  }
  console.log("ENEMY SHOTS DONE");
  console.log(JSON.stringify(fpsLog));
} finally {
  await browser.close();
}
process.exit(0);




