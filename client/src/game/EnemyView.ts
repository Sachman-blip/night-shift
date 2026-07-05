import * as THREE from "three";
import type { AIState } from "../../../shared/messages";

// Eyes are MeshBasicMaterial on purpose: they ignore lighting, so you see
// faint points floating in the dark long before your flashlight finds the
// body. Color escalates with the AI state.
const EYE_COLORS: Record<AIState, number> = {
  patrol: 0x6b1111,
  search: 0xa33314,
  chase: 0xe8241a,
};

const SKIN = () =>
  new THREE.MeshStandardMaterial({ color: 0x131117, roughness: 0.96 });
const SKIN_PALE = () =>
  new THREE.MeshStandardMaterial({ color: 0x1c1a20, roughness: 0.9 });

interface Rig {
  body: THREE.Group;   // lean/hunch pivot
  head: THREE.Group;   // snap/tilt pivot
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
}

/**
 * Three primitive-composed monsters, one per server variant, with
 * procedural animation per AI state:
 *   patrol — slow, almost-normal limb swing; wrongness only up close
 *   chase  — time-quantized jerky flail, forward lean, hard yaw snaps
 *   search — dead still, instant head-snaps, occasional full freezes
 */
export class EnemyView {
  private group = new THREE.Group();
  private rig!: Rig;
  private eyeMat = new THREE.MeshBasicMaterial({ color: EYE_COLORS.patrol });
  private eyes: THREE.Mesh[] = [];
  private variant = "";
  private aiState: AIState = "patrol";
  private targetPos = new THREE.Vector3();
  private targetYaw = 0;
  private animT = 0;
  private snapIn = 1;
  private freezeFor = 0;
  private blinkIn = 3;

  constructor(private scene: THREE.Scene) {
    scene.add(this.group);
  }

  // ---------- model building ----------

  private part(
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0
  ): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  private pivot(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  }

  /** Limb: pivot at the joint, box hanging down its local -y. */
  private limb(
    parent: THREE.Object3D, x: number, y: number, z: number,
    thick: number, len: number, mat: THREE.Material
  ): THREE.Group {
    const p = this.pivot(parent, x, y, z);
    this.part(p, new THREE.BoxGeometry(thick, len, thick), mat, 0, -len / 2, 0);
    return p;
  }

  private eye(parent: THREE.Object3D, x: number, y: number, z: number, r = 0.035) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 8), this.eyeMat);
    e.position.set(x, y, z);
    parent.add(e);
    this.eyes.push(e);
  }

  private rebuild(variant: string) {
    this.variant = variant;
    this.group.clear();
    this.eyes = [];
    // group origin sits at server y=1.05; local floor is y=-1.05
    const body = this.pivot(this.group, 0, 0, 0);
    const B = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

    if (variant === "listener") {
      // squat wide mass, no neck, huge mismatched ear-cones for a head
      this.part(body, B(0.58, 0.72, 0.44), SKIN(), 0, -0.2, 0, 0.06, 0, 0.1);
      this.part(body, B(0.4, 0.24, 0.34), SKIN_PALE(), 0.03, 0.25, -0.02, 0, 0, -0.14);
      const head = this.pivot(body, 0.02, 0.42, 0);
      this.part(head, new THREE.ConeGeometry(0.11, 0.5, 6), SKIN(), -0.16, 0.22, 0, 0, 0, 0.55);
      this.part(head, new THREE.ConeGeometry(0.07, 0.3, 6), SKIN(), 0.17, 0.13, 0.03, 0.15, 0, -0.3);
      this.eye(head, -0.05, 0.02, -0.19, 0.028);
      this.eye(head, 0.07, -0.02, -0.19, 0.022);
      const armL = this.limb(body, -0.32, 0.12, 0, 0.09, 0.55, SKIN());
      const armR = this.limb(body, 0.33, 0.08, 0.04, 0.11, 0.62, SKIN());
      const legL = this.limb(body, -0.15, -0.55, 0, 0.13, 0.52, SKIN());
      const legR = this.limb(body, 0.16, -0.55, 0.03, 0.11, 0.5, SKIN());
      this.rig = { body, head, armL, armR, legL, legR };
    } else if (variant === "sprinter") {
      // low quadruped crouch: torso pitched forward, long forelimbs
      const torso = this.part(body, B(0.28, 0.85, 0.26), SKIN(), 0, -0.25, -0.15, 1.15, 0, 0.07);
      torso.position.y = -0.2;
      const head = this.pivot(body, 0.03, -0.05, -0.62);
      this.part(head, B(0.17, 0.14, 0.24), SKIN_PALE(), 0, 0, -0.08, -0.25, 0, 0.3);
      this.eye(head, -0.06, 0.04, -0.2, 0.03);
      this.eye(head, 0.05, 0.01, -0.21, 0.03);
      const armL = this.limb(body, -0.18, -0.18, -0.42, 0.06, 0.92, SKIN());
      const armR = this.limb(body, 0.2, -0.16, -0.38, 0.06, 0.98, SKIN());
      armL.rotation.x = -0.25;
      armR.rotation.x = -0.32;
      const legL = this.limb(body, -0.13, -0.5, 0.28, 0.09, 0.6, SKIN());
      const legR = this.limb(body, 0.13, -0.52, 0.3, 0.09, 0.56, SKIN());
      legL.rotation.x = 0.5;
      legR.rotation.x = 0.55;
      this.rig = { body, head, armL, armR, legL, legR };
    } else {
      // stalker: unnaturally tall and thin, hunched, one arm too long
      this.part(body, B(0.3, 0.95, 0.22), SKIN(), 0, 0.4, 0, 0.22, 0, 0.06);
      this.part(body, B(0.07, 0.34, 0.07), SKIN_PALE(), 0.02, 0.98, -0.1, 0.5, 0, 0.1);
      const head = this.pivot(body, 0.03, 1.14, -0.18);
      this.part(head, B(0.15, 0.19, 0.17), SKIN_PALE(), 0, 0.06, 0, 0, 0, 0.35);
      this.eye(head, -0.045, 0.1, -0.09);
      this.eye(head, 0.05, 0.04, -0.09, 0.028);
      const armL = this.limb(body, -0.2, 0.78, 0, 0.06, 1.5, SKIN());  // drags near floor
      const armR = this.limb(body, 0.21, 0.8, 0.02, 0.06, 1.0, SKIN());
      armR.rotation.z = -0.18;
      const legL = this.limb(body, -0.1, -0.05, 0.06, 0.08, 1.0, SKIN());
      const legR = this.limb(body, 0.11, -0.05, 0.06, 0.08, 1.0, SKIN());
      this.rig = { body, head, armL, armR, legL, legR };
    }
  }

  // ---------- per-frame ----------

  /** Called every frame with the raw schema object (poll-style). */
  syncFrom(e: {
    x: number; y: number; z: number; yaw: number;
    aiState: AIState; variant?: string;
  }) {
    if ((e.variant ?? "stalker") !== this.variant) this.rebuild(e.variant ?? "stalker");
    this.targetPos.set(e.x, e.y, e.z);
    this.targetYaw = e.yaw;
    if (e.aiState !== this.aiState) {
      this.aiState = e.aiState;
      this.eyeMat.color.setHex(EYE_COLORS[this.aiState] ?? EYE_COLORS.patrol);
    }
  }

  update(dt: number) {
    const chase = this.aiState === "chase";
    const search = this.aiState === "search";

    // position smoothing; yaw snaps unnaturally hard during chase
    const k = 1 - Math.exp(-14 * dt);
    const kYaw = 1 - Math.exp(-(chase ? 30 : 10) * dt);
    this.group.position.lerp(this.targetPos, k);
    let d = (this.targetYaw - this.group.rotation.y) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this.group.rotation.y += d * kYaw;

    const r = this.rig;
    if (!r) return;

    // occasional dead freeze while searching
    if (this.freezeFor > 0) {
      this.freezeFor -= dt;
      return;
    }

    // blink: eyes briefly collapse
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) this.blinkIn = 2 + Math.random() * 5;
    const blink = this.blinkIn < 0.12 ? 0.1 : 1;
    for (const e of this.eyes) e.scale.setY(blink);

    if (search) {
      // settle limbs, then instant head-snaps toward nothing in particular
      for (const limb of [r.armL, r.armR, r.legL, r.legR]) {
        limb.rotation.x *= Math.max(0, 1 - dt * 6);
      }
      r.body.rotation.x *= Math.max(0, 1 - dt * 4);
      this.snapIn -= dt;
      if (this.snapIn <= 0) {
        this.snapIn = 0.7 + Math.random() * 1.1;
        r.head.rotation.y = (Math.random() - 0.5) * 2.6; // no tween: snap
        if (Math.random() < 0.3) this.freezeFor = 0.25 + Math.random() * 0.45;
      }
      return;
    }

    // patrol/chase locomotion
    this.animT += dt * (chase ? 9.5 : 2.4);
    // chase runs on quantized time: motion updates in visible steps
    const t = chase ? this.animT - (this.animT % 0.22) : this.animT;
    const amp = chase ? 0.85 : 0.3;
    const swing = Math.sin(t);
    r.armL.rotation.x = swing * amp * 1.15;
    r.armR.rotation.x = -swing * amp * 0.8;      // asymmetric arm swing
    r.legL.rotation.x = -swing * amp * (this.variant === "sprinter" ? 0.5 : 0.7) +
      (this.variant === "sprinter" ? 0.5 : 0);
    r.legR.rotation.x = swing * amp * 0.65 + (this.variant === "sprinter" ? 0.55 : 0);
    r.body.rotation.x = chase ? 0.32 : 0.04 + Math.sin(t * 0.5) * 0.02;
    r.head.rotation.y = chase ? 0 : Math.sin(this.animT * 0.31) * 0.35;
    this.group.position.y =
      this.targetPos.y + Math.abs(Math.sin(t)) * (chase ? 0.07 : 0.025);
  }
}
