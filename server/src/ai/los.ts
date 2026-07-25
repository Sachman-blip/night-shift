// 2D line-of-sight over a generated layout. A box blocks sight if its
// vertical span covers eye height — walls, partitions, tall cabinets,
// shelf backs; not desks, gurneys, sofas or lintels. Gate doors are
// runtime-dynamic: callers pass the currently-closed ones as extras.

import type { BoxDef, GateDoorDef, GateId } from "../../../shared/map";

export const EYE_HEIGHT = 1.5;

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface LosSystem {
  losClear(x0: number, z0: number, x1: number, z1: number, extra?: Rect[]): boolean;
  gateRects: Record<GateId, Rect[]>;
}

export const toRect = (b: { x: number; z: number; sx: number; sz: number }): Rect => ({
  minX: b.x - b.sx / 2,
  maxX: b.x + b.sx / 2,
  minZ: b.z - b.sz / 2,
  maxZ: b.z + b.sz / 2,
});

export function createLos(boxes: BoxDef[], gateDoors: GateDoorDef[]): LosSystem {
  const blockers: Rect[] = boxes
    .filter((b) => b.y - b.sy / 2 < EYE_HEIGHT && b.y + b.sy / 2 > EYE_HEIGHT)
    .map(toRect);

  const gateRects: Record<GateId, Rect[]> = { archives: [], shortcut: [] };
  for (const d of gateDoors) gateRects[d.gate].push(toRect(d));

  function losClear(
    x0: number, z0: number, x1: number, z1: number, extra?: Rect[]
  ): boolean {
    for (const r of blockers) {
      if (segmentHitsRect(x0, z0, x1, z1, r)) return false;
    }
    if (extra) {
      for (const r of extra) {
        if (segmentHitsRect(x0, z0, x1, z1, r)) return false;
      }
    }
    return true;
  }

  return { losClear, gateRects };
}

export function segmentHitsRect(
  x0: number, z0: number, x1: number, z1: number, r: Rect
): boolean {
  const dx = x1 - x0;
  const dz = z1 - z0;
  let tmin = 0;
  let tmax = 1;

  if (Math.abs(dx) < 1e-9) {
    if (x0 < r.minX || x0 > r.maxX) return false;
  } else {
    let t1 = (r.minX - x0) / dx;
    let t2 = (r.maxX - x0) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }

  if (Math.abs(dz) < 1e-9) {
    if (z0 < r.minZ || z0 > r.maxZ) return false;
  } else {
    let t1 = (r.minZ - z0) / dz;
    let t2 = (r.maxZ - z0) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }

  return true;
}
