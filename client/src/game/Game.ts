import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { getStateCallbacks, type Room } from "colyseus.js";
import {
  MSG,
  MOVE_SEND_RATE_MS,
  type PlayerState,
  type DeathMessage,
  type TeleportMessage,
  type RoundPhase,
} from "../../../shared/messages";
import { CARRY_CAPACITY, PICKUP_RADIUS } from "../../../shared/loot";
import { buildLayout, INTERACT_RADIUS, type Layout } from "../../../shared/map";
import { buildMap, updateFlickers, type BuiltMap } from "./buildMap";
import { PlayerController } from "./PlayerController";
import { RemotePlayers } from "./RemotePlayers";
import { EnemyView } from "./EnemyView";
import { LootView } from "./LootView";
import { GateView } from "./GateView";
import { TouchControls } from "./TouchControls";
import { AudioEngine } from "./audio";
import { VoiceChat } from "./voice";

// Touch devices get virtual controls and a lighter render tier.
// ?touch=1 forces it (testing, hybrid laptops).
const IS_TOUCH =
  matchMedia("(pointer: coarse)").matches ||
  new URLSearchParams(location.search).has("touch");

export class Game {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private world!: RAPIER.World;
  private controller!: PlayerController;
  private remotes!: RemotePlayers;
  private enemyViews = new Map<string, EnemyView>();
  private lootView!: LootView;
  private flashlight!: THREE.SpotLight;
  private map!: BuiltMap;
  private clock = new THREE.Clock();
  private elapsed = 0;
  private sendAccumulator = 0;
  private running = false;
  private prevPhase: RoundPhase = "active";
  private teamListHtml = "";
  private objectivesHtml = "";
  private gateView!: GateView;
  private audio = new AudioEngine();
  private prevCarrying = 0;
  private prevExtractedTotal = 0;
  private prevArchives = false;
  private prevShortcut = false;
  private ambientIn = 20;
  private composer!: EffectComposer;
  private grainPass!: ShaderPass;
  private frameTimes: number[] = [];
  private panic = 0;
  private voice!: VoiceChat;

  constructor(private room: Room) {}

  private layout!: Layout;

  async start() {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

    this.setupRenderer();
    this.setupScene();
    this.setupPost();

    // the first state patch carries both our spawn AND the map layout
    const self = await this.waitForSelfState();
    this.layout = buildLayout(JSON.parse((this.room.state as any).layout));

    this.map = buildMap(this.scene, this.world, RAPIER, this.layout.boxes, this.layout.lights);
    this.remotes = new RemotePlayers(this.scene);
    this.lootView = new LootView(this.scene, this.layout.extractionZone);
    this.gateView = new GateView(
      this.scene, this.world, RAPIER,
      this.layout.gateDoors, this.layout.keycardPos, this.layout.breakerPos
    );
    this.controller = new PlayerController(
      this.world,
      RAPIER,
      this.camera,
      { x: self.x, y: self.y, z: self.z },
      this.renderer.domElement
    );
    this.controller.onInteract = () => this.room.send(MSG.Pickup);
    this.controller.onStep = (sprinting) => this.audio.step(sprinting);
    if (IS_TOUCH) {
      document.body.classList.add("touch");
      document.getElementById("touchUI")!.classList.remove("hidden");
      this.controller.touchMode = true;
      new TouchControls(this.controller, {
        onInteract: () => this.room.send(MSG.Pickup),
      });
      document.getElementById("btnMic")!.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.voice.toggleMute();
      });
      window.addEventListener("touchend", () => {
        this.audio.ensureStarted();
        this.voice.ensureCtx();
      });
    }
    // voice connects opportunistically AFTER game state is already syncing;
    // mic prompt happens here (on join), never on page load
    this.voice = new VoiceChat(this.room);
    void this.voice.init();

    // the same click that grabs pointer lock satisfies the autoplay policy
    this.renderer.domElement.addEventListener("click", () => {
      this.audio.ensureStarted();
      this.voice.ensureCtx();
    });
    this.setupFlashlight();
    this.bindRoomEvents();
    this.bindHud();

    // orient new players the instant they drop in (the checklist stays up top)
    this.toast("FIND LOOT · PRESS E TO GRAB · BANK IT AT THE GREEN EXTRACT LIGHT");

    window.addEventListener("resize", this.onResize);
    this.running = true;
    this.renderer.setAnimationLoop(() => this.tick());

    // debug/capture hooks (screenshot tooling, FPS probes)
    if (new URLSearchParams(location.search).has("debug")) {
      (window as any).__game = {
        setView: (x: number, y: number, z: number, yaw: number, pitch: number) => {
          this.controller.teleport(x, y, z);
          this.controller.yaw = yaw;
          this.controller.pitch = pitch;
        },
        getFps: () => {
          const t = this.frameTimes;
          if (!t.length) return { avg: 0, low: 0 };
          const avg = t.length / t.reduce((a, b) => a + b, 0);
          const worst = Math.max(...t);
          return { avg: Math.round(avg), low: Math.round(1 / worst) };
        },
        room: this.room,
        voice: this.voice,
      };
    }
  }

  // ---------- setup ----------

  private setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // mobile tier: cap resolution harder — fill-rate is the bottleneck
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Cap overall brightness: pulls highlights into ACES' rolloff so surfaces
    // right in front of the flashlight stop blowing out to pure white.
    this.renderer.toneMappingExposure = 0.9;
    document.body.appendChild(this.renderer.domElement);
  }

  private setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020303);
    this.scene.fog = new THREE.FogExp2(0x020303, 0.055);

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      120
    );
    this.scene.add(this.camera);

    // Barely-there fill: unlit zones read near-black, not grey.
    this.scene.add(new THREE.AmbientLight(0x2a3230, 0.22));
  }

  private setupPost() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // subtle bloom: fixtures, the EXTRACT beacon, monitor glow. Higher
    // threshold keeps flashlit walls out of the bloom, so only genuine light
    // sources glow instead of every close surface flaring white.
    this.composer.addPass(
      new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.28, 0.5, 0.95
      )
    );

    // vignette + animated grain: the "dirty" horror image
    this.grainPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uPanic: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uPanic;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float d = distance(vUv, vec2(0.5));
          // vignette tightens as the thing closes in
          c *= 0.62 + 0.38 * smoothstep(0.85 - uPanic * 0.3, 0.3, d);
          float g = fract(sin(dot(vUv + fract(uTime), vec2(12.9898, 78.233))) * 43758.5453);
          c += (g - 0.5) * (0.028 + uPanic * 0.05);                // grain surges
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.composer.addPass(this.grainPass);

    this.composer.addPass(new OutputPass());
    // SMAA is a full-screen pass; on mobile the lower pixel ratio already
    // softens edges, so skip the cost there
    if (!IS_TOUCH) this.composer.addPass(new SMAAPass());
  }

  private setupFlashlight() {
    // Lower intensity + gentler decay (1.6 vs inverse-square 2) so a wall right
    // in your face isn't blinding, while mid-range visibility stays about the
    // same; wider penumbra softens the hotspot.
    this.flashlight = new THREE.SpotLight(0xffe9c4, 30, 24, 0.46, 0.52, 1.6);
    this.flashlight.position.set(0.18, -0.22, 0);
    this.flashlight.target.position.set(0, -0.12, -4);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(IS_TOUCH ? 1024 : 2048, IS_TOUCH ? 1024 : 2048);
    this.flashlight.shadow.camera.near = 0.3;
    this.flashlight.shadow.camera.far = 26;
    this.flashlight.shadow.bias = -0.003;
    this.flashlight.shadow.radius = 3; // soften edges (PCFSoft)
    this.camera.add(this.flashlight, this.flashlight.target);
  }

  // ---------- state sync ----------

  /** Own player entry (with server-assigned spawn) from the first state patch. */
  private waitForSelfState(): Promise<PlayerState> {
    return new Promise((resolve) => {
      const $ = getStateCallbacks(this.room);
      $(this.room.state).players.onAdd((player: PlayerState, id: string) => {
        if (id === this.room.sessionId) resolve(player);
      });
    });
  }

  private bindRoomEvents() {
    const $ = getStateCallbacks(this.room);

    $(this.room.state).players.onAdd((player: PlayerState, id: string) => {
      if (id === this.room.sessionId) return;
      this.remotes.add(id, player);
      $(player).onChange(() => this.remotes.updateTarget(id, player));
    });

    $(this.room.state).players.onRemove((_: PlayerState, id: string) => {
      this.remotes.remove(id);
    });

    this.room.onMessage(MSG.Death, (msg: DeathMessage) => {
      this.controller.teleport(msg.x, 1.05, msg.z);
      this.flashDeath();
      this.audio.sting("death");
    });

    this.room.onMessage(MSG.Teleport, (msg: TeleportMessage) => {
      this.controller.teleport(msg.x, 1.05, msg.z);
    });

    this.room.onLeave(() => {
      this.running = false;
      this.renderer.setAnimationLoop(null);
      document.exitPointerLock?.();
      const menu = document.getElementById("menu")!;
      const error = document.getElementById("menuError")!;
      menu.classList.remove("hidden");
      document.getElementById("hud")!.classList.add("hidden");
      error.textContent = "disconnected from server";
    });
  }

  private sendState() {
    const p = this.controller.getPosition();
    this.room.send(MSG.Move, {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: this.controller.yaw,
      pitch: this.controller.pitch,
      torch: this.controller.torch,
    });
  }

  // ---------- per-frame ----------

  private bindHud() {
    const codeEl = document.getElementById("roomCode")!;
    codeEl.textContent = this.room.roomId;
    // one-tap invites: click the code to copy a join link
    codeEl.addEventListener("click", () => {
      const url = `${location.origin}${location.pathname}?join=${this.room.roomId}`;
      navigator.clipboard?.writeText(url).then(
        () => this.toast("INVITE LINK COPIED — SEND IT TO YOUR CREW"),
        () => this.toast(`INVITE CODE: ${this.room.roomId}`)
      );
    });
    document.getElementById("againBtn")!.addEventListener("click", () => {
      this.room.send(MSG.Restart);
    });
  }

  private tick() {
    if (!this.running) return;
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;
    const st = this.room.state as any;
    const active = st.phase === "active";

    if (active) {
      this.controller.update(dt);
      this.sendAccumulator += dt * 1000;
      if (this.sendAccumulator >= MOVE_SEND_RATE_MS) {
        this.sendAccumulator = 0;
        this.sendState();
      }
    }

    this.flashlight.visible = this.controller.torch;
    this.remotes.update(dt);
    st.enemies.forEach((e: any, id: string) => {
      let view = this.enemyViews.get(id);
      if (!view) {
        view = new EnemyView(this.scene);
        this.enemyViews.set(id, view);
      }
      view.syncFrom(e);
      view.update(dt);
    });
    this.lootView.sync(st.loot, this.elapsed, dt);
    this.gateView.sync(st);
    updateFlickers(this.map.flickers, dt);

    // gate unlock feedback
    if (st.archivesUnlocked && !this.prevArchives) {
      this.toast("SECURITY CARD ACCEPTED — ARCHIVES UNLOCKED");
      this.audio.sting("unlock");
    }
    this.prevArchives = st.archivesUnlocked;
    if (st.shortcutOpen && !this.prevShortcut) {
      this.toast("POWER REROUTED — CAFETERIA SHUTTER OPEN");
      this.audio.sting("unlock");
    }
    this.prevShortcut = st.shortcutOpen;

    // false-alarm atmosphere: distant clangs/creaks on a random timer
    if (active) {
      this.ambientIn -= dt;
      if (this.ambientIn <= 0) {
        this.ambientIn = 18 + Math.random() * 32;
        this.audio.ambientOneShot();
      }
    }

    // enemy proximity layer: track whichever monster is the biggest threat
    // (chasing counts double vs merely being near)
    let enemyDist = Infinity;
    let enemyChasing = false;
    let bestScore = -1;
    st.enemies.forEach((e: any) => {
      const d = Math.hypot(
        e.x - this.camera.position.x,
        e.y - this.camera.position.y,
        e.z - this.camera.position.z
      );
      const prox = Math.max(0, 1 - d / 25);
      const score = prox * prox * (e.aiState === "chase" ? 1 : 0.5);
      if (score > bestScore) {
        bestScore = score;
        enemyDist = d;
        enemyChasing = e.aiState === "chase";
      }
    });
    this.audio.update(enemyDist, enemyChasing, active, dt);

    // close-chase panic: camera breathing + vignette/grain surge
    const panicTarget =
      active && enemyChasing
        ? Math.max(0, Math.min(1, 1 - enemyDist / 7))
        : 0;
    this.panic += (panicTarget - this.panic) * Math.min(1, dt * 4);
    const fov = 75 + this.panic * (2 + Math.sin(this.elapsed * 9) * 1.6);
    if (Math.abs(fov - this.camera.fov) > 0.02) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.grainPass.uniforms.uPanic.value = this.panic;

    // stingers from state diffs (works for events caused by any tick)
    const self = st.players.get(this.room.sessionId);
    const carrying = self?.carrying ?? 0;
    if (carrying > this.prevCarrying) this.audio.sting("pickup");
    this.prevCarrying = carrying;
    if (st.extractedTotal > this.prevExtractedTotal) this.audio.sting("bank");
    this.prevExtractedTotal = st.extractedTotal;

    if (st.phase !== this.prevPhase) {
      this.prevPhase = st.phase;
      if (st.phase === "ended") {
        this.showResults(st);
        this.audio.sting(st.win ? "win" : "loss");
      } else {
        this.hideResults();
      }
    }

    this.updateHud(st, active);

    this.grainPass.uniforms.uTime.value = this.elapsed;
    this.composer.render();

    // rolling FPS window for the debug probe
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 240) this.frameTimes.shift();
  }

  private updateHud(st: any, active: boolean) {
    document.getElementById("playerCount")!.textContent = String(
      this.remotes.count + 1
    );
    document
      .getElementById("lockPrompt")!
      .classList.toggle("hidden", IS_TOUCH || !active || this.controller.isLocked());

    // timer
    const t = st.timeLeft ?? 0;
    const timerEl = document.getElementById("timer")!;
    timerEl.textContent =
      `${String(Math.floor(t / 60)).padStart(2, "0")}:` +
      `${String(t % 60).padStart(2, "0")}`;
    timerEl.classList.toggle("low", active && t <= 60);

    // loot counters
    const self = st.players.get(this.room.sessionId);
    document.getElementById("carryCount")!.textContent =
      `${self?.carrying ?? 0}/${CARRY_CAPACITY}`;
    document.getElementById("bankCount")!.textContent =
      `${st.extractedTotal}/${st.quota}`;

    // mic state indicator
    const micEl = document.getElementById("micHud")!;
    const micState = this.voice?.micState ?? "pending";
    const micText = { live: "[V] MIC LIVE", muted: "[V] MIC MUTED", none: "NO MIC", pending: "MIC…" }[micState];
    if (micEl.textContent !== micText) micEl.textContent = micText;
    micEl.classList.toggle("muted", micState !== "live");

    // teammates: name, carried count, deaths, talking indicator
    let html = "";
    st.players.forEach((p: any, id: string) => {
      const you = id === this.room.sessionId ? " (you)" : "";
      const deaths = p.deaths > 0 ? ` <span class="dead">✕${p.deaths}</span>` : "";
      const talk = this.voice?.isSpeaking(id) ? ` <span class="talk">◉</span>` : "";
      html += `<div>${escapeHtml(p.name)}${you} · ${p.carrying}/${CARRY_CAPACITY}${deaths}${talk}</div>`;
    });
    if (html !== this.teamListHtml) {
      this.teamListHtml = html;
      document.getElementById("teamList")!.innerHTML = html;
    }

    // live objective checklist — the thing new players were missing
    const carrying = self?.carrying ?? 0;
    const banked = st.extractedTotal ?? 0;
    const quota = st.quota ?? 0;
    const grabbedEver = carrying > 0 || (self?.extractedCount ?? 0) > 0 || banked > 0;
    let obj = `<div class="head">◆ OBJECTIVE</div>`;
    obj += `<div class="${grabbedEver ? "done" : "todo"}">`
      + `${grabbedEver ? "✓" : "1."} GRAB loot — walk over it, press E</div>`;
    obj += `<div class="${banked >= quota && quota > 0 ? "done" : "todo"}">`
      + `${banked >= quota && quota > 0 ? "✓" : "2."} BANK it in the EXTRACT zone `
      + `(green light) · ${banked}/${quota}</div>`;
    if (!st.keycardTaken) {
      obj += `<div class="hintline">◆ grab the SECURITY CARD to open the ARCHIVES</div>`;
    }
    obj += `<div class="warn">☠ don't get caught — you drop your haul</div>`;
    if (obj !== this.objectivesHtml) {
      this.objectivesHtml = obj;
      document.getElementById("objectives")!.innerHTML = obj;
    }

    // stamina bar: only visible when not full (no HUD noise at rest)
    const stam = this.controller.stamina;
    const wrap = document.getElementById("stamWrap")!;
    wrap.classList.toggle("visible", stam < 0.999);
    const fill = document.getElementById("stamFill")!;
    fill.style.width = `${Math.round(stam * 100)}%`;
    fill.classList.toggle("locked", this.controller.staminaLocked);

    // interact prompt: keycard > breaker > loot
    const prompt = document.getElementById("grabPrompt")!;
    let promptText: string | null = null;
    if (active && self) {
      const { keycardPos, breakerPos } = this.layout;
      if (
        !st.keycardTaken &&
        Math.hypot(keycardPos.x - self.x, keycardPos.z - self.z) <= INTERACT_RADIUS
      ) {
        promptText = "TAKE SECURITY CARD";
      } else if (
        !st.shortcutOpen &&
        Math.hypot(breakerPos.x - self.x, breakerPos.z - self.z) <= INTERACT_RADIUS
      ) {
        promptText = "REROUTE POWER";
      } else {
        const near = this.lootView.nearestGround(st.loot, self.x, self.z);
        if (near.dist <= PICKUP_RADIUS && self.carrying < CARRY_CAPACITY) {
          promptText = `GRAB ${near.label}`;
        }
      }
    }
    prompt.classList.toggle("hidden", promptText === null);
    if (promptText !== null) {
      document.getElementById("grabLabel")!.textContent = promptText;
    }
  }

  private toast(text: string) {
    const el = document.getElementById("toast")!;
    el.textContent = text;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 3200);
  }

  private showResults(st: any) {
    document.exitPointerLock?.();
    const shift = st.shift ?? 1;
    const title = document.getElementById("resultsTitle")!;
    title.textContent = `SHIFT ${shift} ${st.win ? "COMPLETE" : "FAILED"}`;
    title.classList.toggle("loss", !st.win);
    document.getElementById("resultsSub")!.textContent = st.win
      ? `quota met. shift ${shift + 1} will want more of you.`
      : `the clock ran out. shift ${shift} again — the building is patient.`;
    // a cleared shift moves you forward; a failed one is retried in place
    document.getElementById("againBtn")!.textContent = st.win
      ? "NEXT SHIFT"
      : "RETRY SHIFT";

    const players: any[] = [];
    st.players.forEach((p: any) => players.push(p));
    players.sort((a, b) => b.extractedCount - a.extractedCount);

    let rows = "";
    for (const p of players) {
      const fate =
        p.deaths > 0
          ? `<span class="fate dead">✕ caught ×${p.deaths}</span>`
          : `<span class="fate">clean</span>`;
      rows += `<div class="row"><span>${escapeHtml(p.name)}</span>` +
        `<span>${p.extractedCount} extracted</span>${fate}</div>`;
    }
    rows += `<div class="row total"><span>TEAM</span>` +
      `<span>${st.extractedTotal}/${st.quota} extracted</span><span></span></div>`;
    document.getElementById("resultsRows")!.innerHTML = rows;
    document.getElementById("results")!.classList.remove("hidden");
  }

  private hideResults() {
    document.getElementById("results")!.classList.add("hidden");
  }

  private flashDeath() {
    const el = document.getElementById("deathFlash")!;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 900);
  }

  private onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
