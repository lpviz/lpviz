import type { Vec } from "./types";

export interface BoundingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** A half-line start + t·direction, t ≥ 0. */
export interface Ray {
  start: Vec;
  direction: Vec;
}

export function expandDegenerateBounds(bounds: BoundingBox, minExtent = 1): BoundingBox {
  let { minX, maxX, minY, maxY } = bounds;
  if (maxX - minX < minExtent) {
    const centerX = (minX + maxX) / 2;
    minX = centerX - minExtent / 2;
    maxX = centerX + minExtent / 2;
  }
  if (maxY - minY < minExtent) {
    const centerY = (minY + maxY) / 2;
    minY = centerY - minExtent / 2;
    maxY = centerY + minExtent / 2;
  }
  return { minX, maxX, minY, maxY };
}

const RAY_CLIP_EPS = 1e-10;

/** The ray clipped to the box: its start and the farthest boundary hit, or null when it never enters the box. */
export function clipRayToBoundingBox({ start, direction }: Ray, bounds: BoundingBox): [Vec, Vec] | null {
  const candidates: Array<{ t: number; point: Vec }> = [];

  if (Math.abs(direction[0]) > RAY_CLIP_EPS) {
    for (const x of [bounds.minX, bounds.maxX]) {
      const t = (x - start[0]) / direction[0];
      if (t <= RAY_CLIP_EPS) continue;
      const y = start[1] + t * direction[1];
      if (y >= bounds.minY - RAY_CLIP_EPS && y <= bounds.maxY + RAY_CLIP_EPS) {
        candidates.push({ t, point: [x, y] });
      }
    }
  }

  if (Math.abs(direction[1]) > RAY_CLIP_EPS) {
    for (const y of [bounds.minY, bounds.maxY]) {
      const t = (y - start[1]) / direction[1];
      if (t <= RAY_CLIP_EPS) continue;
      const x = start[0] + t * direction[0];
      if (x >= bounds.minX - RAY_CLIP_EPS && x <= bounds.maxX + RAY_CLIP_EPS) {
        candidates.push({ t, point: [x, y] });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.t - a.t);
  return [start, candidates[0]!.point];
}
