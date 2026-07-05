import * as THREE from "three";
import type { PlayerState } from "../../../shared/messages";
import { WALK_SPEED } from "../../../shared/messages";

const PLAYER_COLORS = [0xc7663d, 0x4f83c2, 0x63a86a, 0xa25fbb];

interface Rig {
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
}

interface Remote {
  group: THREE.Group;       // positioned at capsule center, rotates with yaw
  visual: THREE.Group;      // inner group: walk bob without fighting the lerp
  head: THREE.Group;        // rotates with pitch, carries the torch
  torch: THREE.SpotLight;
  tag: THREE.Sprite;        // name tag; sprite always faces the camera
  rig: Rig;
  phase: number;            // walk-cycle phase, advances with distance moved
  amp: number;              // smoothed swing amplitude (0 idle .. ~1 walking)
  target: {
    pos: THREE.Vector3;
    yaw: number;
    pitch: number;
    torch: boolean;
  };
}

/**
 * Renders and interpolates other players. State patches arrive at ~20hz;
 * exponential smoothing toward the latest snapshot keeps motion fluid at
 * render framerate without a full snapshot buffer (good enough for co-op).
 *
 * Players are primitive-composed humans (same approach as EnemyView):
 * jumpsuit torso + jointed limbs, helmet head with visor and torch.
 * Group origin sits at the network capsule center; local floor is y=-1.0.
 */
export class RemotePlayers {
  private remotes = new Map<string, Remote>();

  private torsoGeo = new THREE.BoxGeometry(0.44, 0.6, 0.26);
  private pelvisGeo = new THREE.BoxGeometry(0.4, 0.18, 0.24);
  private neckGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  private headGeo = new THREE.BoxGeometry(0.3, 0.28, 0.3);
  private visorGeo = new THREE.BoxGeometry(0.24, 0.09, 0.06);
  private armGeo = new THREE.BoxGeometry(0.11, 0.6, 0.11);
  private handGeo = new THREE.BoxGeometry(0.09, 0.12, 0.09);
  private legGeo = new THREE.BoxGeometry(0.14, 0.8, 0.14);
  private bootGeo = new THREE.BoxGeometry(0.15, 0.12, 0.22);

  constructor(private scene: THREE.Scene) {}

  get count(): number {
    return this.remotes.size;
  }

  private part(
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number, y: number, z: number
  ): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  /** Name tag: text drawn to a canvas, shown as a camera-facing sprite. */
  private makeNameTag(name: string, color: number): THREE.Sprite {
    const fontSize = 44;
    const pad = 14;
    const font = `600 ${fontSize}px system-ui, sans-serif`;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = font;
    canvas.width = Math.ceil(ctx.measureText(name).width) + pad * 2;
    canvas.height = fontSize + pad * 2;
    ctx.font = font; // resizing the canvas resets context state

    // dark backing pill so the name reads against black corridors
    ctx.fillStyle = "rgba(8, 10, 9, 0.55)";
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, canvas.height / 2);
    ctx.fill();

    // player color, lightened for legibility
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle =
      "#" + new THREE.Color(color).lerp(new THREE.Color(1, 1, 1), 0.4).getHexString();
    ctx.fillText(name, canvas.width / 2, canvas.height / 2 + 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    const h = 0.22; // world height; width follows canvas aspect
    sprite.scale.set((canvas.width / canvas.height) * h, h, 1);
    sprite.position.y = 1.0; // just above the head
    return sprite;
  }

  /** Limb: pivot at the joint, segment hanging down its local -y. */
  private limb(
    parent: THREE.Object3D, x: number, y: number, z: number,
    geo: THREE.BufferGeometry, len: number, mat: THREE.Material
  ): THREE.Group {
    const p = new THREE.Group();
    p.position.set(x, y, z);
    parent.add(p);
    this.part(p, geo, mat, 0, -len / 2, 0);
    return p;
  }

  add(sessionId: string, state: PlayerState) {
    const color = PLAYER_COLORS[state.colorIndex % PLAYER_COLORS.length];

    const suit = new THREE.MeshLambertMaterial({ color });
    const suitDark = new THREE.MeshLambertMaterial({
      color: new THREE.Color(color).multiplyScalar(0.55),
    });
    const gear = new THREE.MeshLambertMaterial({ color: 0x24262a });

    const group = new THREE.Group();
    const visual = new THREE.Group();
    group.add(visual);

    // trunk: pelvis + torso + neck (floor at local y=-1.0, so ~1.8m tall)
    this.part(visual, this.pelvisGeo, suitDark, 0, -0.02, 0);
    this.part(visual, this.torsoGeo, suit, 0, 0.26, 0);
    this.part(visual, this.neckGeo, gear, 0, 0.56, 0);

    // head: helmet + visor, pivots with pitch and carries the torch
    const head = new THREE.Group();
    head.position.y = 0.62;
    this.part(head, this.headGeo, new THREE.MeshLambertMaterial({ color: 0x2a2d2a }), 0, 0.06, 0);
    const visor = new THREE.Mesh(
      this.visorGeo,
      new THREE.MeshLambertMaterial({
        color: 0x9fe0d8,
        emissive: 0x365b56,
      })
    );
    visor.position.set(0, 0.04, -0.16); // face marker: forward is -z
    head.add(visor);

    const torch = new THREE.SpotLight(0xffe9c4, 14, 15, 0.5, 0.55, 2);
    torch.position.set(0.15, 0, -0.1);
    torch.target.position.set(0, 0, -4);
    head.add(torch, torch.target);
    visual.add(head);

    // limbs: shoulders at y=0.46, hips at y=-0.08; hands end mid-thigh,
    // boot soles land exactly on the local floor (-1.0)
    const armL = this.limb(visual, -0.29, 0.46, 0, this.armGeo, 0.6, suit);
    const armR = this.limb(visual, 0.29, 0.46, 0, this.armGeo, 0.6, suit);
    this.part(armL, this.handGeo, gear, 0, -0.64, 0);
    this.part(armR, this.handGeo, gear, 0, -0.64, 0);

    const legL = this.limb(visual, -0.13, -0.08, 0, this.legGeo, 0.8, suit);
    const legR = this.limb(visual, 0.13, -0.08, 0, this.legGeo, 0.8, suit);
    this.part(legL, this.bootGeo, gear, 0, -0.86, -0.04);
    this.part(legR, this.bootGeo, gear, 0, -0.86, -0.04);

    // name tag on the outer group: stays put while the body bobs
    const tag = this.makeNameTag(state.name, color);
    group.add(tag);

    group.position.set(state.x, state.y, state.z);
    this.scene.add(group);

    this.remotes.set(sessionId, {
      group,
      visual,
      head,
      torch,
      tag,
      rig: { armL, armR, legL, legR },
      phase: 0,
      amp: 0,
      target: {
        pos: new THREE.Vector3(state.x, state.y, state.z),
        yaw: state.yaw,
        pitch: state.pitch,
        torch: state.torch,
      },
    });
  }

  updateTarget(sessionId: string, state: PlayerState) {
    const r = this.remotes.get(sessionId);
    if (!r) return;
    r.target.pos.set(state.x, state.y, state.z);
    r.target.yaw = state.yaw;
    r.target.pitch = state.pitch;
    r.target.torch = state.torch;
  }

  remove(sessionId: string) {
    const r = this.remotes.get(sessionId);
    if (!r) return;
    this.scene.remove(r.group);
    r.tag.material.map?.dispose(); // canvas textures are per-player GPU state
    r.tag.material.dispose();
    this.remotes.delete(sessionId);
  }

  update(dt: number) {
    const k = 1 - Math.exp(-14 * dt); // framerate-independent smoothing
    const kAmp = 1 - Math.exp(-8 * dt);
    const SNAP_DIST_SQ = 6 * 6; // beyond this it's a teleport (respawn), not movement
    for (const r of this.remotes.values()) {
      const prevX = r.group.position.x;
      const prevZ = r.group.position.z;
      // teleports (e.g. respawn after being caught) snap instead of visibly
      // sliding the body across the whole map
      if (r.group.position.distanceToSquared(r.target.pos) > SNAP_DIST_SQ) {
        r.group.position.copy(r.target.pos);
        r.group.rotation.y = r.target.yaw;
        r.amp = 0;
        r.phase = 0;
      } else {
        r.group.position.lerp(r.target.pos, k);
        r.group.rotation.y = lerpAngle(r.group.rotation.y, r.target.yaw, k);
      }
      r.head.rotation.x = THREE.MathUtils.lerp(
        r.head.rotation.x,
        r.target.pitch,
        k
      );
      r.torch.visible = r.target.torch;

      // walk cycle driven by rendered horizontal movement: phase advances
      // with distance so stride frequency tracks speed, amplitude eases in
      // and out so limbs settle to neutral when the player stops
      const dist = Math.min(
        Math.hypot(r.group.position.x - prevX, r.group.position.z - prevZ),
        1 // a snapped frame shouldn't spin the walk cycle
      );
      const speed = dt > 0 ? dist / dt : 0;
      r.amp = THREE.MathUtils.lerp(
        r.amp,
        THREE.MathUtils.clamp(speed / WALK_SPEED, 0, 1.5),
        kAmp
      );
      r.phase += dist * 2.6; // rad per meter -> ~0.7s stride at walk speed
      const swing = Math.sin(r.phase) * 0.55 * r.amp;
      r.rig.legL.rotation.x = swing;
      r.rig.legR.rotation.x = -swing;
      r.rig.armL.rotation.x = -swing * 0.75;
      r.rig.armR.rotation.x = swing * 0.75;
      r.visual.position.y =
        Math.abs(Math.sin(r.phase)) * 0.04 * Math.min(r.amp, 1);
    }
  }
}

/** Lerp between angles along the shortest arc (avoids 359°->1° spins). */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
