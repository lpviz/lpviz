import type { Constraint, Vec } from "./types";

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

// a point or a segment is fitted as if it were at least this wide
const MIN_EXTENT = 1;

/** The box widened about its center to at least MIN_EXTENT on each axis. */
export function expandDegenerateBounds(bounds: BoundingBox): BoundingBox {
  let { minX, maxX, minY, maxY } = bounds;
  if (maxX - minX < MIN_EXTENT) {
    const centerX = (minX + maxX) / 2;
    minX = centerX - MIN_EXTENT / 2;
    maxX = centerX + MIN_EXTENT / 2;
  }
  if (maxY - minY < MIN_EXTENT) {
    const centerY = (minY + maxY) / 2;
    minY = centerY - MIN_EXTENT / 2;
    maxY = centerY + MIN_EXTENT / 2;
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

const CLIP_EPS = 1e-10;

/** The line a·x + b·y = c across the box, as its two points on the box's extent along the line's gentler axis; null for a degenerate line. */
export function clipLineToBoundingBox([a, b, c]: Constraint, box: BoundingBox): [Vec, Vec] | null {
  if (Math.abs(a) < CLIP_EPS && Math.abs(b) < CLIP_EPS) return null;
  if (Math.abs(b) > Math.abs(a)) {
    return [
      [box.minX, (c - a * box.minX) / b],
      [box.maxX, (c - a * box.maxX) / b],
    ];
  }
  return [
    [(c - b * box.minY) / a, box.minY],
    [(c - b * box.maxY) / a, box.maxY],
  ];
}

// Sutherland–Hodgman: the polygon kept inside the half-plane a·x + b·y <= c.
function clipPolygonToHalfPlane(polygon: Vec[], [a, b, c]: Constraint): Vec[] {
  if (polygon.length === 0) return [];
  const inside = (p: Vec) => a * p[0] + b * p[1] <= c + CLIP_EPS;
  const intersect = (s: Vec, e: Vec): Vec => {
    const dx = e[0] - s[0],
      dy = e[1] - s[1];
    const denom = a * dx + b * dy;
    if (Math.abs(denom) < CLIP_EPS) return e;
    const t = (c - a * s[0] - b * s[1]) / denom;
    return [s[0] + t * dx, s[1] + t * dy];
  };
  const result: Vec[] = [];
  let prev = polygon[polygon.length - 1]!,
    prevIn = inside(prev);
  for (const cur of polygon) {
    const curIn = inside(cur);
    if (curIn) {
      if (!prevIn) result.push(intersect(prev, cur));
      result.push(cur);
    } else if (prevIn) result.push(intersect(prev, cur));
    prev = cur;
    prevIn = curIn;
  }
  return result;
}

/** The box cut down by every half-plane a·x + b·y <= c: the polygon's vertices, empty once nothing is left. */
export function clipHalfPlanesToBoundingBox(constraints: readonly Constraint[], bounds: BoundingBox): Vec[] {
  let polygon: Vec[] = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ];
  for (const line of constraints) {
    polygon = clipPolygonToHalfPlane(polygon, line);
    if (polygon.length === 0) return [];
  }
  return polygon;
}
