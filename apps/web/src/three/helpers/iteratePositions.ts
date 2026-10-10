import { iterateHeight, type IteratePath } from "@/features/solver/solverState";

// Write `count` iterates of a path into `dst` as [x, y, z]*count: iterate i, or iterate indices[i]
// when a subset of the path is drawn. z is the render-space height from iterateHeight; the zScale
// and 2D/3D-transition flatten are applied per-layer via object3D.scale.z, never baked here.
export function writeIteratePositions(dst: Float32Array, path: IteratePath, count = path.count, indices: readonly number[] | null = null): void {
  const { points, stride } = path;
  for (let i = 0; i < count; i++) {
    const index = indices ? indices[i]! : i;
    const s = index * stride;
    const o = i * 3;
    dst[o] = points[s]!;
    dst[o + 1] = points[s + 1]!;
    dst[o + 2] = iterateHeight(path, index);
  }
}

// The same flat path in a shared grow-only scratch (valid until the next call):
// every caller copies it into its own texture or attribute synchronously.
let scratch = new Float32Array(0);

export function iteratePositions(path: IteratePath): Float32Array {
  if (scratch.length < path.count * 3) {
    scratch = new Float32Array(path.count * 3);
  }
  writeIteratePositions(scratch, path);
  return scratch;
}

/** One [x, y, z] for the iterate at `index`, or null when the index is out of range. */
export function iteratePosition(path: IteratePath, index: number): [number, number, number] | null {
  if (index < 0 || index >= path.count) return null;
  const base = index * path.stride;
  return [path.points[base]!, path.points[base + 1]!, iterateHeight(path, index)];
}

/** The render height of the iterate at `index`, or the floor when there is no such iterate. */
export function iterateHeightOrFloor(path: IteratePath, index: number): number {
  return index >= 0 && index < path.count ? iterateHeight(path, index) : 0;
}
