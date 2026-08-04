import type { Room } from "colyseus.js";
import { createRoom, joinRoom, wakeServer } from "./net";
import { Game } from "./game/Game";

const menu = document.getElementById("menu")!;
const hud = document.getElementById("hud")!;
const nameInput = document.getElementById("nameInput") as HTMLInputElement;
const codeInput = document.getElementById("codeInput") as HTMLInputElement;
const createBtn = document.getElementById("createBtn") as HTMLButtonElement;
const joinBtn = document.getElementById("joinBtn") as HTMLButtonElement;
const menuError = document.getElementById("menuError")!;

let busy = false;

async function enter(connect: () => Promise<Room>) {
  if (busy) return;
  busy = true;
  createBtn.disabled = joinBtn.disabled = true;
  menuError.textContent = "";
  try {
    // free-tier server may be asleep; this returns instantly when it is awake
    await wakeServer((seconds) => {
      menuError.classList.add("waking");
      menuError.textContent =
        `waking the building up… ${seconds}s ` +
        `(the server sleeps when nobody's on shift)`;
    });
    menuError.classList.remove("waking");
    menuError.textContent = "";
    const room = await connect();
    menu.classList.add("hidden");
    hud.classList.remove("hidden");
    await new Game(room).start();
  } catch (err: any) {
    console.error(err);
    menuError.classList.remove("waking");
    menuError.textContent = friendlyError(err);
    menu.classList.remove("hidden");
    hud.classList.add("hidden");
  } finally {
    busy = false;
    createBtn.disabled = joinBtn.disabled = false;
  }
}

function friendlyError(err: any): string {
  const msg = String(err?.message ?? err ?? "unknown error");
  if (/not found/i.test(msg)) return "no shift with that code";
  if (/locked|full|max/i.test(msg)) return "that shift is full";
  if (/refused|failed to fetch|network|timeout/i.test(msg)) {
    return "can't reach the server — is it running?";
  }
  return msg.toLowerCase();
}

createBtn.addEventListener("click", () =>
  enter(() => createRoom(nameInput.value))
);

// invite links: ?join=CODE pre-fills and auto-joins
const inviteCode = new URLSearchParams(location.search).get("join");
if (inviteCode && /^[A-Z2-9]{4}$/i.test(inviteCode)) {
  codeInput.value = inviteCode.toUpperCase();
  enter(() => joinRoom(inviteCode, nameInput.value));
}

joinBtn.addEventListener("click", () => {
  const code = codeInput.value.trim();
  if (code.length !== 4) {
    menuError.textContent = "codes are 4 characters";
    return;
  }
  enter(() => joinRoom(code, nameInput.value));
});

codeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") createBtn.click();
});
