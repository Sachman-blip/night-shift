import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { GateDoorDef, GateId } from "../../../shared/map";

interface GateDoor {
  gate: GateId;
  mesh: THREE.Mesh;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider | null;
  desc: RAPIER.ColliderDesc;
}

/**
 * Runtime-toggleable map elements: the keycard-locked archive doors, the
 * powered shutter, the keycard itself, and the breaker box. All driven by
 * synced state flags each frame (poll-style, like enemy/loot).
 */
export class GateView {
  private doors: GateDoor[] = [];
  private keycard: THREE.Mesh;
  private breakerLamp: THREE.MeshLambertMaterial;

  constructor(
    scene: THREE.Scene,
    private world: RAPIER.World,
    R: typeof RAPIER,
    gateDoors: GateDoorDef[],
    keycardPos: { x: number; z: number; y: number },
    breakerPos: { x: number; z: number }
  ) {
    for (const d of gateDoors) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(d.sx, d.sy, d.sz),
        new THREE.MeshLambertMaterial({ color: d.color })
      );
      mesh.position.set(d.x, d.y, d.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);

      const body = world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(d.x, d.y, d.z)
      );
      const desc = R.ColliderDesc.cuboid(d.sx / 2, d.sy / 2, d.sz / 2);
      const collider = world.createCollider(desc, body);
      this.doors.push({ gate: d.gate, mesh, body, collider, desc });
    }

    // security card on the conference table
    this.keycard = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.02, 0.18),
      new THREE.MeshLambertMaterial({
        color: 0xe8e8f0,
        emissive: 0x8899bb,
        emissiveIntensity: 0.25,
      })
    );
    this.keycard.position.set(keycardPos.x, keycardPos.y, keycardPos.z);
    scene.add(this.keycard);

    // breaker box on the maintenance wall, with a status lamp
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.7, 0.5),
      new THREE.MeshLambertMaterial({ color: 0x3c4044 })
    );
    box.position.set(breakerPos.x, 1.4, breakerPos.z);
    scene.add(box);
    this.breakerLamp = new THREE.MeshLambertMaterial({
      color: 0x442222,
      emissive: 0xcc3322,
      emissiveIntensity: 0.9,
    });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.08), this.breakerLamp);
    lamp.position.set(breakerPos.x - 0.1, 1.65, breakerPos.z);
    scene.add(lamp);
  }

  /** Called each frame with the raw room state. */
  sync(st: { archivesUnlocked: boolean; shortcutOpen: boolean; keycardTaken: boolean }) {
    for (const d of this.doors) {
      const open = d.gate === "archives" ? st.archivesUnlocked : st.shortcutOpen;
      if (open && d.collider) {
        this.world.removeCollider(d.collider, true);
        d.collider = null;
        d.mesh.visible = false;
      } else if (!open && !d.collider) {
        // round restart re-locks the doors
        d.collider = this.world.createCollider(d.desc, d.body);
        d.mesh.visible = true;
      }
    }

    this.keycard.visible = !st.keycardTaken;
    const powered = st.shortcutOpen;
    this.breakerLamp.emissive.setHex(powered ? 0x33cc55 : 0xcc3322);
  }
}
