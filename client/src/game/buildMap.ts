import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type RAPIER from "@dimforge/rapier3d-compat";
import { WALL_HEIGHT, COLORS, type BoxDef, type LightDef } from "../../../shared/map";

// Per-material-family PBR properties, keyed by palette color. Anything not
// listed gets matte defaults. Screens/LEDs glow faintly on their own.
const SURFACE: Record<number, { rough: number; metal: number; emissive?: number; ei?: number }> = {
  [COLORS.metal]: { rough: 0.38, metal: 0.8 },
  [COLORS.metalDark]: { rough: 0.45, metal: 0.75 },
  [COLORS.gurney]: { rough: 0.4, metal: 0.7 },
  [COLORS.gate]: { rough: 0.5, metal: 0.8 },
  [COLORS.serverBox]: { rough: 0.4, metal: 0.6 },
  [COLORS.pipe]: { rough: 0.5, metal: 0.7 },
  [COLORS.vending]: { rough: 0.45, metal: 0.25 },
  [COLORS.screen]: { rough: 0.25, metal: 0.1, emissive: 0x16453a, ei: 0.55 },
  [COLORS.led]: { rough: 0.4, metal: 0.2, emissive: 0x77e0a0, ei: 1.4 },
  [COLORS.mug]: { rough: 0.35, metal: 0 },
  [COLORS.wood]: { rough: 0.75, metal: 0 },
  [COLORS.woodLight]: { rough: 0.7, metal: 0 },
  [COLORS.floor]: { rough: 0.85, metal: 0.05 },
  [COLORS.wall]: { rough: 0.92, metal: 0 },
  [COLORS.ceiling]: { rough: 0.95, metal: 0 },
  [COLORS.partition]: { rough: 0.97, metal: 0 },
  [COLORS.chair]: { rough: 0.95, metal: 0 },
  [COLORS.sofa]: { rough: 0.97, metal: 0 },
};

/** A ceiling fixture whose light dies and revives at random intervals. */
export interface Flicker {
  light: THREE.PointLight;
  tube: THREE.Mesh;
  baseIntensity: number;
  timer: number;
}

export interface BuiltMap {
  flickers: Flicker[];
  /** Everything added to the scene, so a new shift can tear it all down. */
  objects: THREE.Object3D[];
  bodies: RAPIER.RigidBody[];
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
}

const DEFAULT_LIGHT = 0xcfe8c4;

export function buildMap(
  scene: THREE.Scene,
  world: RAPIER.World,
  R: typeof RAPIER,
  boxes: BoxDef[],
  lightPoints: LightDef[]
): BuiltMap {
  // Geometry + colliders from the same layout data. ~450 boxes would mean
  // ~450 draw calls (x2 with the flashlight's shadow pass), so merge into
  // one mesh per color. Colliders stay per-box; deco boxes get none.
  const byColor = new Map<number, THREE.BufferGeometry[]>();
  const objects: THREE.Object3D[] = [];
  const bodies: RAPIER.RigidBody[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  for (const b of boxes) {
    const geo = new THREE.BoxGeometry(b.sx, b.sy, b.sz);
    geo.translate(b.x, b.y, b.z);
    let list = byColor.get(b.color);
    if (!list) {
      list = [];
      byColor.set(b.color, list);
    }
    list.push(geo);

    if (!b.deco) {
      const body = world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(b.x, b.y, b.z)
      );
      world.createCollider(
        R.ColliderDesc.cuboid(b.sx / 2, b.sy / 2, b.sz / 2),
        body
      );
      bodies.push(body);
    }
  }

  for (const [color, geos] of byColor) {
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    const s = SURFACE[color] ?? { rough: 0.9, metal: 0 };
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: s.rough,
      metalness: s.metal,
      emissive: s.emissive ?? 0x000000,
      emissiveIntensity: s.ei ?? 1,
    });
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    objects.push(mesh);
    geometries.push(merged);
    materials.push(material);
  }

  // Ceiling fixtures. "off" ones still get a dead tube mesh so rooms
  // read as abandoned rather than unfinished. Tint varies per zone.
  const tubeGeo = new THREE.BoxGeometry(1.4, 0.1, 0.4);
  const offMat = new THREE.MeshLambertMaterial({ color: 0x23261f });
  geometries.push(tubeGeo);
  materials.push(offMat);
  const flickers: Flicker[] = [];

  for (const def of lightPoints) {
    const on = def.mode !== "off";
    const tint = def.color ?? DEFAULT_LIGHT;
    let tubeMat: THREE.Material = offMat;
    if (on) {
      tubeMat = new THREE.MeshLambertMaterial({
        color: 0x333833,
        emissive: tint,
        emissiveIntensity: 0.9,
      });
      materials.push(tubeMat);
    }
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.position.set(def.x, WALL_HEIGHT - 0.06, def.z);
    scene.add(tube);
    objects.push(tube);
    if (!on) continue;

    const light = new THREE.PointLight(tint, 14, 13, 2);
    light.position.set(def.x, WALL_HEIGHT - 0.25, def.z);
    scene.add(light);
    objects.push(light);

    if (def.mode === "flicker") {
      flickers.push({ light, tube, baseIntensity: 14, timer: 0 });
    }
  }

  return { flickers, objects, bodies, geometries, materials };
}

/**
 * Tear down a built map: a new shift re-rolls the layout, so every mesh,
 * collider and light from the previous arrangement has to go. Rapier bodies
 * take their colliders with them.
 */
export function disposeMap(
  scene: THREE.Scene,
  world: RAPIER.World,
  built: BuiltMap
) {
  for (const o of built.objects) scene.remove(o);
  for (const b of built.bodies) world.removeRigidBody(b);
  for (const g of built.geometries) g.dispose();
  for (const m of built.materials) m.dispose();
  built.objects = [];
  built.bodies = [];
  built.geometries = [];
  built.materials = [];
  built.flickers = [];
}

export function updateFlickers(flickers: Flicker[], dt: number) {
  for (const f of flickers) {
    f.timer -= dt;
    if (f.timer > 0) continue;
    const alive = Math.random() > 0.42;
    f.light.intensity = alive ? f.baseIntensity * (0.4 + Math.random()) : 0.0;
    (f.tube.material as THREE.MeshLambertMaterial).emissiveIntensity = alive
      ? 0.5 + Math.random() * 0.6
      : 0.02;
    // Mostly rapid stutter, occasionally a longer dead or lit stretch.
    f.timer =
      Math.random() < 0.15 ? 0.6 + Math.random() * 1.8 : 0.04 + Math.random() * 0.22;
  }
}
