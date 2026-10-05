import { computeFlatZ, type IteratePath } from "@/features/core/store";
import type { PointXY } from "@lpviz/math/types";

// Write a flat iterate/trace path into `dst` as [x, y, z]*count. z is the render-space height from
// computeFlatZ; the zScale and 2D/3D-transition flatten are applied per-layer via
// object3D.scale.z, never baked here.
export function writeFlatXYZ(dst: Float32Array, points: Float64Array, count: number, stride: number, objectiveVector: PointXY | null): void {
  for (let i = 0; i < count; i++) {
    const s = i * stride;
    const o = i * 3;
    dst[o] = points[s]!;
    dst[o + 1] = points[s + 1]!;
    dst[o + 2] = computeFlatZ(points, s, stride, objectiveVector);
  }
}

// The same flat path in a shared grow-only scratch (valid until the next call):
// every caller copies it into its own texture or attribute synchronously.
let scratch = new Float32Array(0);

export function flatXYZ(points: Float64Array, count: number, stride: number, objectiveVector: PointXY | null): Float32Array {
  if (scratch.length < count * 3) {
    scratch = new Float32Array(count * 3);
  }
  writeFlatXYZ(scratch, points, count, stride, objectiveVector);
  return scratch;
}

// One [x, y, z] for the iterate at `index`, used by the single-point sprite
// layers (star / highlight). Returns null when the index is out of range.
export function flatPointXYZ(path: IteratePath, index: number, objectiveVector: PointXY | null): [number, number, number] | null {
  if (index < 0 || index >= path.count) return null;
  const base = index * path.stride;
  return [path.points[base]!, path.points[base + 1]!, computeFlatZ(path.points, base, path.stride, objectiveVector)];
}
