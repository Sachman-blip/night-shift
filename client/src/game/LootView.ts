import * as THREE from "three";
import { LOOT_TYPES } from "../../../shared/loot";

interface LootItem {
  mesh: THREE.Object3D;
  kind: string;
  bobPhase: number;
}

// Zone identity color: cyan. Deliberately absent from every loot type,
// the pale-green fluorescents, the warm flashlight, and the red enemy eyes.
const ZONE_COLOR = 0x3fd6f0;

/**
 * Renders loot from room state (poll-style each frame, like the enemy).
 * Ground items hover-bob and slowly spin — the classic pickup affordance —
 * with a faint emissive so a flashlight sweep catches them. Carried and
 * extracted items are hidden.
 */
export class LootView {
  private items = new Map<string, LootItem>();
  private zoneMat: THREE.MeshBasicMaterial;
  private pillarMats: THREE.MeshBasicMaterial[] = [];
  private zoneLight: THREE.PointLight;
  private sign: THREE.Sprite;
  private signBaseY = 2.85;

  constructor(
    private scene: THREE.Scene,
    zone: { x: number; z: number; sx: number; sz: number }
  ) {
    // Extraction zone beacon — built to be unmissable in a flashlight-only
    // scene: every part is MeshBasicMaterial (self-lit, ignores darkness)
    // with fog disabled, so it reads from the far end of the corridor.

    // glowing floor pad
    this.zoneMat = new THREE.MeshBasicMaterial({
      color: ZONE_COLOR,
      transparent: true,
      opacity: 0.35,
      fog: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(zone.sx, zone.sz), this.zoneMat);
    quad.rotation.x = -Math.PI / 2;
    quad.position.set(zone.x, 0.02, zone.z);
    scene.add(quad);

    // floor-to-ceiling light column (two nested translucent cylinders)
    for (const [radius, opacity] of [[0.45, 0.22], [1.0, 0.09]] as const) {
      const mat = new THREE.MeshBasicMaterial({
        color: ZONE_COLOR,
        transparent: true,
        opacity,
        fog: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius * 1.35, 3.2, 24, 1, true),
        mat
      );
      pillar.position.set(zone.x, 1.6, zone.z);
      scene.add(pillar);
      this.pillarMats.push(mat);
    }

    // "EXTRACT" marker: renders through walls (depthTest off) so the zone
    // is findable from anywhere — objective-marker style, not scenery.
    this.sign = this.makeSign();
    this.sign.position.set(zone.x, this.signBaseY, zone.z);
    scene.add(this.sign);

    // cyan spill on the surrounding walls/floor
    this.zoneLight = new THREE.PointLight(ZONE_COLOR, 8, 12, 2);
    this.zoneLight.position.set(zone.x, 2.4, zone.z);
    scene.add(this.zoneLight);
  }

  private makeSign(): THREE.Sprite {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 192;
    const g = c.getContext("2d")!;
    g.textAlign = "center";
    g.shadowColor = "#3fd6f0";
    g.shadowBlur = 28;
    g.fillStyle = "#c8f4ff";
    g.font = "bold 66px Consolas, monospace";
    g.fillText("EXTRACT", 256, 78);
    g.font = "bold 54px Consolas, monospace";
    g.fillText("▼", 256, 158);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      fog: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(4.2, 1.6, 1);
    sprite.renderOrder = 999;
    return sprite;
  }

  // Composite, recognizable-by-silhouette models from primitives.
  // Barely self-lit (emissive 0.06): findable only by flashlight sweep.
  private createMesh(kind: string): THREE.Object3D {
    const g = new THREE.Group();
    const base = LOOT_TYPES[kind]?.color ?? 0xc9b46a;
    const mat = (
      color: number,
      rough = 0.75,
      metal = 0,
      emissiveScale = 0.06
    ) =>
      new THREE.MeshStandardMaterial({
        color,
        roughness: rough,
        metalness: metal,
        emissive: new THREE.Color(color).multiplyScalar(emissiveScale),
      });
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, ry = 0) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      mesh.castShadow = true;
      g.add(mesh);
      return mesh;
    };
    const B = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

    switch (kind) {
      case "files": { // bound stack with an askew top sheet
        const paper = mat(0xd8d2c0, 0.9);
        add(B(0.42, 0.05, 0.32), mat(base, 0.85), 0, -0.05, 0);
        add(B(0.42, 0.05, 0.32), mat(base, 0.85), 0.015, 0, 0.01, 0.09);
        add(B(0.4, 0.04, 0.3), paper, -0.01, 0.045, -0.005, -0.14);
        add(B(0.38, 0.008, 0.28), paper, 0.03, 0.075, 0.02, 0.32);
        add(B(0.44, 0.1, 0.05), mat(0x4a3a2a, 0.8), 0, -0.02, -0.16); // binding
        break;
      }
      case "typewriter": {
        const body = mat(base, 0.5, 0.4);
        add(B(0.46, 0.14, 0.36), body, 0, 0, 0);
        add(B(0.5, 0.07, 0.08), mat(0x2a3138, 0.4, 0.6), 0, 0.12, -0.12); // carriage
        add(B(0.38, 0.03, 0.09), mat(0x22262a, 0.6), 0, 0.09, 0.06);      // key row
        add(B(0.34, 0.03, 0.08), mat(0x22262a, 0.6), 0, 0.11, 0.13);      // key row
        add(B(0.24, 0.22, 0.01), mat(0xe0dcc8, 0.95), 0, 0.24, -0.14);    // paper up
        break;
      }
      case "radio": {
        add(B(0.42, 0.28, 0.16), mat(base, 0.6), 0, 0, 0);
        add(B(0.2, 0.2, 0.02), mat(0x1c2126, 0.9), -0.08, 0, 0.085);      // grille
        add(B(0.05, 0.05, 0.03), mat(0xd8d5c8, 0.4, 0.5), 0.12, 0.05, 0.085); // knob
        add(B(0.05, 0.05, 0.03), mat(0xd8d5c8, 0.4, 0.5), 0.12, -0.05, 0.085);
        add(B(0.02, 0.34, 0.02), mat(0x8a9296, 0.35, 0.9), 0.17, 0.3, -0.05); // antenna
        break;
      }
      case "cashbox": { // fanned stack of banded bills
        const bill = mat(base, 0.85);
        add(B(0.34, 0.045, 0.17), bill, 0, -0.045, 0, 0.0);
        add(B(0.34, 0.045, 0.17), bill, 0.02, 0.0, 0.01, 0.28);
        add(B(0.34, 0.045, 0.17), bill, -0.015, 0.045, -0.01, -0.22);
        add(B(0.34, 0.045, 0.17), bill, 0.01, 0.09, 0.015, 0.5);
        add(B(0.08, 0.05, 0.18), mat(0xd8d5c8, 0.9), 0, 0.045, 0);        // band
        break;
      }
      case "medkit": {
        add(B(0.38, 0.2, 0.28), mat(base, 0.55), 0, 0, 0);
        add(B(0.05, 0.012, 0.2), mat(0xb03030, 0.6, 0, 0.12), 0, 0.107, 0);  // cross
        add(B(0.2, 0.012, 0.05), mat(0xb03030, 0.6, 0, 0.12), 0, 0.107, 0);
        add(B(0.1, 0.04, 0.02), mat(0x8a9296, 0.35, 0.9), 0, 0.02, 0.15);    // latch
        break;
      }
      case "specimen": { // jar: translucent glass, dark lid, something inside
        const glass = new THREE.MeshStandardMaterial({
          color: 0x9adbc0,
          roughness: 0.15,
          metalness: 0,
          transparent: true,
          opacity: 0.4,
          emissive: new THREE.Color(base).multiplyScalar(0.08),
        });
        add(new THREE.CylinderGeometry(0.13, 0.13, 0.3, 14), glass, 0, 0.02, 0);
        add(new THREE.CylinderGeometry(0.14, 0.14, 0.05, 14), mat(0x2e3436, 0.5, 0.4), 0, 0.19, 0);
        add(new THREE.SphereGeometry(0.07, 10, 8), mat(0x3a4a3e, 0.9), 0.01, -0.02, 0);
        break;
      }
      case "harddrive": {
        add(B(0.3, 0.09, 0.24), mat(0x2a2e34, 0.45, 0.6), 0, 0, 0);
        const disc = add(
          new THREE.CylinderGeometry(0.08, 0.08, 0.012, 16),
          mat(0xb8bec6, 0.2, 0.95),
          -0.03, 0.052, 0
        );
        disc.rotation.y = 0.3;
        add(B(0.1, 0.005, 0.16), mat(base, 0.8, 0, 0.1), 0.09, 0.048, 0);   // label
        break;
      }
      default:
        add(B(0.35, 0.25, 0.3), mat(base), 0, 0, 0);
    }

    this.scene.add(g);
    return g;
  }

  /** Called every frame with the raw loot MapSchema. */
  sync(loot: any, time: number, dt: number) {
    const seen = new Set<string>();
    loot.forEach((l: any, id: string) => {
      seen.add(id);
      let item = this.items.get(id);
      if (!item || item.kind !== l.kind) {
        if (item) this.scene.remove(item.mesh);
        item = {
          mesh: this.createMesh(l.kind),
          kind: l.kind,
          bobPhase: (id.charCodeAt(1) || 0) * 1.7,
        };
        this.items.set(id, item);
      }
      const visible = l.carrier === "" && !l.extracted;
      item.mesh.visible = visible;
      if (visible) {
        item.mesh.position.set(
          l.x,
          l.y + 0.07 * Math.sin(time * 2 + item.bobPhase),
          l.z
        );
        item.mesh.rotation.y += dt * 0.8;
      }
    });

    for (const [id, item] of this.items) {
      if (!seen.has(id)) {
        this.scene.remove(item.mesh);
        this.items.delete(id);
      }
    }

    // beacon pulse: floor pad, light column, spill light, bobbing sign
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.2);
    this.zoneMat.opacity = 0.25 + 0.2 * pulse;
    this.pillarMats[0].opacity = 0.16 + 0.14 * pulse;
    this.pillarMats[1].opacity = 0.06 + 0.06 * pulse;
    this.zoneLight.intensity = 5 + 5 * pulse;
    this.sign.position.y = this.signBaseY + 0.1 * Math.sin(time * 1.4);
  }

  /** Nearest ground loot to a point, for the grab prompt. */
  nearestGround(loot: any, x: number, z: number): { dist: number; label: string } {
    let dist = Infinity;
    let label = "";
    loot.forEach((l: any) => {
      if (l.carrier !== "" || l.extracted) return;
      const d = Math.hypot(l.x - x, l.z - z);
      if (d < dist) {
        dist = d;
        label = LOOT_TYPES[l.kind]?.label ?? "LOOT";
      }
    });
    return { dist, label };
  }
}
