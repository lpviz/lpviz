// Planar polygons and polylines over Vec points: the shapes the 2-variable editor draws.

import type { Vec } from "./types";

const FULL_TURN = 2 * Math.PI;
const TURNING_TOLERANCE = 1e-6;

/** The turn at `p1` between the edges p0→p1 and p1→p2: their cross product, dot product and lengths. */
export function turn(p0: Vec, p1: Vec, p2: Vec) {
  const ax = p1[0] - p0[0];
  const ay = p1[1] - p0[1];
  const bx = p2[0] - p1[0];
  const by = p2[1] - p1[1];
  return { cross: ax * by - ay * bx, dot: ax * bx + ay * by, lengths: Math.hypot(ax, ay) * Math.hypot(bx, by) };
}

function isConvexSequence(points: readonly Vec[], closed: boolean, tol: number): boolean {
  const n = points.length;
  if (n < 3) return true;
  const turnCount = closed ? n : n - 2;

  let orientation = 0;
  let turning = 0;
  for (let i = 0; i < turnCount; i++) {
    const { cross, dot } = turn(points[i]!, points[(i + 1) % n]!, points[(i + 2) % n]!);
    if (Math.abs(cross) <= tol) {
      // straight continuation (or a repeated point) is fine; a reversal is not
      if (dot < -tol) return false;
      continue;
    }
    const sign = Math.sign(cross);
    if (orientation === 0) orientation = sign;
    else if (sign !== orientation) return false;
    turning += Math.atan2(cross, dot);
  }
  // every turn degenerate: the points are collinear, and the region derivation
  // reports the degenerate shape itself
  if (orientation === 0) return true;

  const revolutions = Math.abs(turning) / FULL_TURN;
  return closed ? Math.abs(revolutions - 1) <= TURNING_TOLERANCE : revolutions <= 1 + TURNING_TOLERANCE;
}

/** A polyline that is part of the boundary of some convex polygon. */
export function isConvexChain(points: readonly Vec[], tol = 1e-9): boolean {
  return isConvexSequence(points, false, tol);
}

/** A closed polygon that is convex (and therefore simple). */
export function isConvexPolygon(points: readonly Vec[], tol = 1e-9): boolean {
  return isConvexSequence(points, true, tol);
}

/** The mean of the points, coordinate by coordinate. */
export function centroid(points: readonly Vec[]): Vec {
  const first = points[0];
  if (!first) throw new Error("The centroid of no points is undefined");
  const sums = new Array<number>(first.length).fill(0);
  for (const point of points) {
    for (let j = 0; j < sums.length; j++) sums[j] = sums[j]! + point[j]!;
  }
  return sums.map((sum) => sum / points.length) as Vec;
}

export function signedArea(points: readonly Vec[], tol = 1e-12): number {
  if (points.length < 3) return 0;

  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    area += current[0] * next[1] - next[0] * current[1];
  }

  const normalizedArea = area / 2;
  return Math.abs(normalizedArea) <= tol ? 0 : normalizedArea;
}

/** Whether `point` lies inside the polygon `points` (false for fewer than three points). */
export function polygonContains(points: readonly Vec[], point: Vec): boolean {
  if (points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i]![0];
    const yi = points[i]![1];
    const xj = points[j]![0];
    const yj = points[j]![1];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Where `point` projects onto the segment start→end: the edge vector, its squared length and the
 * parameter t of the projection (0 at `start`, 1 at `end`; 0 when the segment is degenerate).
 */
export function segmentProjection(point: Vec, start: Vec, end: Vec) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / len2;
  return { dx, dy, len2, t };
}

/** Distance from `point` to the segment start→end (to its nearest endpoint when the projection falls outside). */
export function distanceToSegment(point: Vec, start: Vec, end: Vec): number {
  const { dx, dy, len2, t } = segmentProjection(point, start, end);
  if (len2 === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(point[0] - (start[0] + clamped * dx), point[1] - (start[1] + clamped * dy));
}

// Distance from `point` to edge `edgeIndex`, or +Infinity when the point's projection falls
// outside the segment, the edge is degenerate, or the edge does not exist (the closing edge of a
// polyline, with `closed` false).
function distanceToEdge(points: readonly Vec[], point: Vec, edgeIndex: number, closed: boolean): number {
  const start = points[edgeIndex];
  const end = closed ? points[(edgeIndex + 1) % points.length] : points[edgeIndex + 1];
  if (!start || !end) return Number.POSITIVE_INFINITY;

  const { dx, dy, len2, t } = segmentProjection(point, start, end);
  if (len2 === 0) return Number.POSITIVE_INFINITY;
  if (t < 0 || t > 1) return Number.POSITIVE_INFINITY;

  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

/**
 * The edge of `points` within `tolerance` of `point`, nearest first: a small polytope seen up
 * close puts several edges inside the tolerance at once, and the first in index order is the wrong
 * one as often as not. `closed` false treats the points as a polyline and never tests the
 * last→first chord.
 */
export function nearestEdge(points: readonly Vec[], point: Vec, tolerance = 0.5, closed = true): number | null {
  let nearestIndex: number | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const edgeCount = closed ? points.length : Math.max(0, points.length - 1);
  for (let i = 0; i < edgeCount; i++) {
    const distance = distanceToEdge(points, point, i, closed);
    if (distance < tolerance && distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }
  return nearestIndex;
}

/** The convex hull of `points` as a counterclockwise polygon (Andrew's monotone chain). */
export function convexHull(points: readonly Vec[]): Vec[] {
  if (points.length <= 1) {
    return points.map((pt) => [pt[0], pt[1]]);
  }

  const sorted = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));

  const uniqueSorted: Vec[] = [];
  for (const pt of sorted) {
    const last = uniqueSorted[uniqueSorted.length - 1];
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) {
      uniqueSorted.push([pt[0], pt[1]]);
    }
  }

  if (uniqueSorted.length <= 2) {
    return uniqueSorted.map((pt) => [pt[0], pt[1]]);
  }

  const cross = (o: Vec, a: Vec, b: Vec) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Vec[] = [];
  for (const pt of uniqueSorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, pt) <= 0) {
      lower.pop();
    }
    lower.push([pt[0], pt[1]]);
  }

  const upper: Vec[] = [];
  for (let i = uniqueSorted.length - 1; i >= 0; i--) {
    const pt = uniqueSorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, pt) <= 0) {
      upper.pop();
    }
    upper.push([pt[0], pt[1]]);
  }

  lower.pop();
  upper.pop();

  return lower.concat(upper);
}
