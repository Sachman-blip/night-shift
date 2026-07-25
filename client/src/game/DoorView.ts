import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { COLORS, type DoorDef } from "../../../shared/map";

/** How far a door swings when it opens. */
const OPEN_ANGLE = 1.48; // ~85 degrees
const SWING_SPEED = 7.5; // rad/s
/** A forced door is thrown open, not eased. */
const SLAM_SPEED = 22;

interface Door {
  def: DoorDef;
  pivot: THREE.Object3D;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider | null;
  desc: RAPIER.ColliderDesc;
  angle: number;
  open: boolean;
  slam: boolean;
}

/**
 * The swinging doors: player-operable, monster-breakable. Open/closed comes
 * from a synced boolean array, so every client agrees; the swing itself is
 * pure local animation. The collider is binary (present while shut) — a door
 * that is on its way open is already walk-through, which is what you want
 * when you are the one running for it.
 */
export class DoorView {
  private doors: Door[] = [];
  private geo: THREE.BufferGeometry[] = [];
  private mat: THREE.Material;
  private handleMat: THREE.Material;

  constructor(
    scene: THREE.Scene,
    private world: RAPIER.World,
    R: typeof RAPIER,
    defs: DoorDef[]
  ) {
    this.mat = new THREE.MeshStandardMaterial({
      color: COLORS.door,
      roughness: 0.8,
      metalness: 0.05,
    });
    this.handleMat = new THREE.MeshStandardMaterial({
      color: 0x8a9296,
      roughness: 0.35,
      metalness: 0.9,
    });

    for (const def of defs) {
      const width = def.alongX ? def.sx : def.sz;
      const thickness = def.alongX ? def.sz : def.sx;

      // The pivot sits on the hinge; the panel is authored extending along
      // the pivot's local +X, so one geometry works for every orientation.
      const pivot = new THREE.Object3D();
      const half = (width / 2) * def.hinge;
      pivot.position.set(
        def.alongX ? def.x - half : def.x,
        def.y,
        def.alongX ? def.z : def.z - half
      );
      pivot.rotation.y = this.baseYaw(def);

      const panelGeo = new THREE.BoxGeometry(width, def.sy, thickness);
      panelGeo.translate(width / 2, 0, 0);
      this.geo.push(panelGeo);
      const panel = new THREE.Mesh(panelGeo, this.mat);
      panel.castShadow = true;
      panel.receiveShadow = true;
      pivot.add(panel);

      // a lever handle on the far edge: reads as "you can touch this"
      const handleGeo = new THREE.BoxGeometry(0.18, 0.04, 0.05);
      handleGeo.translate(width - 0.18, -0.05, thickness / 2 + 0.03);
      this.geo.push(handleGeo);
      pivot.add(new THREE.Mesh(handleGeo, this.handleMat));

      scene.add(pivot);

      const body = world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(def.x, def.y, def.z)
      );
      const desc = R.ColliderDesc.cuboid(def.sx / 2, def.sy / 2, def.sz / 2);
      this.doors.push({
        def, pivot, body, desc,
        collider: null, angle: OPEN_ANGLE, open: true, slam: false,
      });
    }
  }

  /** Yaw that maps the panel's local +X onto the direction it should span. */
  private baseYaw(def: DoorDef): number {
    if (def.alongX) return def.hinge < 0 ? 0 : Math.PI;
    return def.hinge < 0 ? -Math.PI / 2 : Math.PI / 2;
  }

  /** Called every frame with the synced open/closed bits. */
  sync(flags: ArrayLike<boolean>, dt: number) {
    for (let i = 0; i < this.doors.length; i++) {
      const d = this.doors[i];
      const open = flags[i] !== false;
      if (open !== d.open) {
        d.open = open;
        if (open) {
          // free the player the instant it starts moving
          if (d.collider) {
            this.world.removeCollider(d.collider, true);
            d.collider = null;
          }
        } else {
          // shut means shut: block immediately, animate the rest
          if (!d.collider) d.collider = this.world.createCollider(d.desc, d.body);
          d.slam = false;
        }
      }

      const target = open ? OPEN_ANGLE : 0;
      const speed = d.slam ? SLAM_SPEED : SWING_SPEED;
      const delta = target - d.angle;
      if (Math.abs(delta) > 0.001) {
        const step = Math.min(Math.abs(delta), speed * dt) * Math.sign(delta);
        d.angle += step;
      } else {
        d.angle = target;
        // A slam queued by the Forced broadcast has to survive until the open
        // bit arrives in the next state patch — the broadcast is immediate but
        // the patch is up to PATCH_RATE_MS behind it, and clearing the flag
        // here would ease the swing that is supposed to be thrown.
        if (open) d.slam = false;
      }
      d.pivot.rotation.y = this.baseYaw(d.def) + d.angle;
    }
  }

  /** A monster tore this one off its latch — throw it instead of easing it. */
  slam(index: number) {
    const d = this.doors[index];
    if (d) d.slam = true;
  }

  /** Nearest door to a point, for the interact prompt. */
  nearest(x: number, z: number): { index: number; dist: number; open: boolean } {
    let index = -1;
    let dist = Infinity;
    let open = true;
    for (let i = 0; i < this.doors.length; i++) {
      const d = this.doors[i];
      const dd = Math.hypot(d.def.x - x, d.def.z - z);
      if (dd < dist) {
        dist = dd;
        index = i;
        open = d.open;
      }
    }
    return { index, dist, open };
  }

  dispose(scene: THREE.Scene) {
    for (const d of this.doors) {
      if (d.collider) this.world.removeCollider(d.collider, true);
      this.world.removeRigidBody(d.body);
      scene.remove(d.pivot);
    }
    for (const g of this.geo) g.dispose();
    this.mat.dispose();
    this.handleMat.dispose();
    this.doors = [];
    this.geo = [];
  }
}
