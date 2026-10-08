// An open chain's end edges continue as rays; these say where those rays go and whether they
// close the chain back onto itself.

import type { Ray } from "@lpviz/math/bounds";
import type { Constraint, Vec } from "@lpviz/math/types";

const TOLERANCE = 1e-6;

/** The two rays leaving an open chain: out of its first vertex, away from the second, and likewise at the end. */
export function buildOpenBoundaryRays(points: readonly Vec[]): Ray[] {
  if (points.length < 2) {
    return [];
  }

  const first = points[0]!;
  const second = points[1]!;
  const penultimate = points[points.length - 2]!;
  const last = points[points.length - 1]!;

  return [
    { start: [first[0], first[1]], direction: [first[0] - second[0], first[1] - second[1]] },
    { start: [last[0], last[1]], direction: [last[0] - penultimate[0], last[1] - penultimate[1]] },
  ];
}

// Parameters along each ray of the point where their lines cross, or null
// when they are parallel within tol.
function rayParams([x1, y1]: Vec, [dx1, dy1]: Vec, [x2, y2]: Vec, [dx2, dy2]: Vec, tol: number): [number, number] | null {
  const det = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(det) < tol) return null;
  const tx = x2 - x1;
  const ty = y2 - y1;
  return [(tx * dy2 - ty * dx2) / det, (tx * dy1 - ty * dx1) / det];
}

const satisfiesAll = (point: Vec, constraints: readonly Constraint[], tol: number) => constraints.every(([A, B, C]) => A * point[0] + B * point[1] <= C + tol);

function intersectOpenBoundaryRays(rays: Ray[], constraints: readonly Constraint[], tol: number): Vec | null {
  if (rays.length !== 2) return null;
  const r1 = rays[0]!;
  const r2 = rays[1]!;
  const params = rayParams(r1.start, r1.direction, r2.start, r2.direction, tol);
  if (!params || params[0] < -tol || params[1] < -tol) return null;
  const point: Vec = [r1.start[0] + params[0] * r1.direction[0], r1.start[1] + params[0] * r1.direction[1]];
  return satisfiesAll(point, constraints, tol) ? point : null;
}

function intersectRayWithSegment(ray: Ray, segStart: Vec, segEnd: Vec, tol: number): Vec | null {
  const params = rayParams(ray.start, ray.direction, segStart, [segEnd[0] - segStart[0], segEnd[1] - segStart[1]], tol);
  if (!params || params[0] < -tol || params[1] < -tol || params[1] > 1 + tol) return null;
  return [ray.start[0] + params[0] * ray.direction[0], ray.start[1] + params[0] * ray.direction[1]];
}

function intersectSegmentWithBoundary(segStart: Vec, segEnd: Vec, constraint: Constraint, tol: number): Vec | null {
  const [sx, sy] = segStart;
  const sdx = segEnd[0] - segStart[0];
  const sdy = segEnd[1] - segStart[1];
  const [A, B, C] = constraint;

  const denom = A * sdx + B * sdy;
  if (Math.abs(denom) < tol) return null;

  const t = (C - A * sx - B * sy) / denom;
  if (t <= tol || t >= 1 - tol) return null;

  return [sx + t * sdx, sy + t * sdy];
}

function terminalSegmentClosesAgainstNonAdjacentConstraint(points: readonly Vec[], terminalSegmentIndex: number, constraints: readonly Constraint[], tol: number): boolean {
  const segStart = points[terminalSegmentIndex]!;
  const segEnd = points[terminalSegmentIndex + 1]!;

  for (let i = 0; i < constraints.length; i++) {
    // Skip the segment's own constraint and those of adjacent edges, which all
    // pass through one of the segment's endpoints. (Index arithmetic is not
    // reliable here: constraintsFromChain skips degenerate edges, so
    // constraints[i] does not necessarily correspond to edge i.)
    const [A, B, C] = constraints[i]!;
    if (Math.abs(A * segStart[0] + B * segStart[1] - C) <= tol || Math.abs(A * segEnd[0] + B * segEnd[1] - C) <= tol) {
      continue;
    }
    const intersection = intersectSegmentWithBoundary(segStart, segEnd, constraints[i]!, tol);
    if (intersection && satisfiesAll(intersection, constraints, tol)) {
      return true;
    }
  }

  return false;
}

/** Whether the open chain's end rays (or its end segments and the other constraints) close it into a bounded region. */
export function hasOpenBoundaryClosure(points: readonly Vec[], constraints: readonly Constraint[], tol = TOLERANCE): boolean {
  const rays = buildOpenBoundaryRays(points);
  if (intersectOpenBoundaryRays(rays, constraints, tol)) return true;
  if (points.length < 4) return false;

  // Test each ray against every segment except its own adjacent one
  // (segment 0 for the start ray, segment points.length - 2 for the end
  // ray); hits at the shared vertex of a neighboring segment are already
  // rejected by the ray parameter's >= -tol check since that vertex lies behind the ray.
  const startRay = rays[0]!;
  const endRay = rays[1]!;
  for (let i = 1; i < points.length - 1; i++) {
    if (intersectRayWithSegment(startRay, points[i]!, points[i + 1]!, tol)) return true;
  }
  for (let i = 0; i < points.length - 2; i++) {
    if (intersectRayWithSegment(endRay, points[i]!, points[i + 1]!, tol)) return true;
  }

  return [0, points.length - 2].some((index) => terminalSegmentClosesAgainstNonAdjacentConstraint(points, index, constraints, tol));
}
