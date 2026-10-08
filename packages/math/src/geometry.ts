import type { Line, Lines, Vec, Vertices } from "./types";

export interface BoundingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
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

const FULL_TURN = 2 * Math.PI;
const TURNING_TOLERANCE = 1e-6;

function isConvexSequence(points: ReadonlyArray<Vec>, closed: boolean, tol: number): boolean {
  const n = points.length;
  if (n < 3) return true;
  const turnCount = closed ? n : n - 2;

  let orientation = 0;
  let turning = 0;
  for (let i = 0; i < turnCount; i++) {
    const p0 = points[i]!;
    const p1 = points[(i + 1) % n]!;
    const p2 = points[(i + 2) % n]!;
    const ax = p1[0] - p0[0];
    const ay = p1[1] - p0[1];
    const bx = p2[0] - p1[0];
    const by = p2[1] - p1[1];
    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
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
export function isConvexChain(points: ReadonlyArray<Vec>, tol = 1e-9): boolean {
  return isConvexSequence(points, false, tol);
}

/** A closed polygon that is convex (and therefore simple). */
export function isConvexPolygon(points: ReadonlyArray<Vec>, tol = 1e-9): boolean {
  return isConvexSequence(points, true, tol);
}

export function centroid(vertices: ReadonlyArray<Vec>, emptyMessage = "No intersections found"): [number, number] {
  if (vertices.length === 0) throw new Error(emptyMessage);
  let sumX = 0;
  let sumY = 0;
  for (const p of vertices) {
    sumX += p[0];
    sumY += p[1];
  }
  return [sumX / vertices.length, sumY / vertices.length];
}

export function signedArea(points: ReadonlyArray<Vec>, tol = 1e-12): number {
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
export function polygonContains(points: ReadonlyArray<Vec>, point: Vec): boolean {
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

// Distance from `point` to edge `edgeIndex`, or +Infinity when the point's projection falls
// outside the segment, the edge is degenerate, or the edge does not exist (the closing edge of a
// polyline, with `closed` false).
function distanceToEdge(points: ReadonlyArray<Vec>, point: Vec, edgeIndex: number, closed: boolean): number {
  const start = points[edgeIndex];
  const end = closed ? points[(edgeIndex + 1) % points.length] : points[edgeIndex + 1];
  if (!start || !end) return Number.POSITIVE_INFINITY;

  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Number.POSITIVE_INFINITY;

  const t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / len2;
  if (t < 0 || t > 1) return Number.POSITIVE_INFINITY;

  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

/**
 * The edge of `points` within `tolerance` of `point`, nearest first: a small polytope seen up
 * close puts several edges inside the tolerance at once, and the first in index order is the wrong
 * one as often as not. `closed` false treats the points as a polyline and never tests the
 * last→first chord.
 */
export function nearestEdge(points: ReadonlyArray<Vec>, point: Vec, tolerance = 0.5, closed = true): number | null {
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
export function convexHull(points: ReadonlyArray<Vec>): Vec[] {
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

export type RegionKind = "bounded" | "unbounded" | "empty" | "degenerate";

function satisfiesLines(point: [number, number], lines: Lines, tol = 1e-6): boolean {
  return lines.every(([A, B, C]) => A * point[0] + B * point[1] <= C + tol);
}

// Where two constraint lines cross, or null when they are parallel within
// tol. The expression order is part of the solvers' input; keep it.
function intersectLines([A1, B1, C1]: Line, [A2, B2, C2]: Line, tol: number): [number, number] | null {
  const det = A1 * B2 - A2 * B1;
  if (Math.abs(det) < tol) return null;
  return [(C1 * B2 - C2 * B1) / det, (A1 * C2 - A2 * C1) / det];
}

export function findFeasiblePoint(lines: Lines, tol = 1e-6): [number, number] | null {
  if (lines.length === 0) {
    return null;
  }

  const candidates: Array<[number, number]> = [[0, 0]];

  for (let i = 0; i < lines.length; i++) {
    const [A, B, C] = lines[i]!;
    const basePoint: [number, number] = [A * C, B * C];
    candidates.push(basePoint);
    for (const step of [1, 10, 100]) candidates.push([basePoint[0] - A * step, basePoint[1] - B * step]);
    for (let j = i + 1; j < lines.length; j++) {
      const point = intersectLines(lines[i]!, lines[j]!, tol);
      if (point) candidates.push(point);
    }
  }

  for (const candidate of candidates) {
    if (satisfiesLines(candidate, lines, tol)) {
      return candidate;
    }
  }

  return null;
}

export function findStrictFeasiblePoint(lines: Lines, tol = 1e-6): [number, number] | null {
  const feasiblePoint = findFeasiblePoint(lines, tol);
  if (!feasiblePoint) {
    return null;
  }
  const strictlyInside = (p: [number, number]) => lines.every(([A, B, C]) => A * p[0] + B * p[1] < C - tol);
  if (strictlyInside(feasiblePoint)) {
    return feasiblePoint;
  }

  const radii = [0.01, 0.1, 1, 10];
  const directions = 32;
  for (const radius of radii) {
    for (let i = 0; i < directions; i++) {
      const angle = (2 * Math.PI * i) / directions;
      const candidate: [number, number] = [feasiblePoint[0] + radius * Math.cos(angle), feasiblePoint[1] + radius * Math.sin(angle)];
      if (strictlyInside(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

// The unit directions along each constraint boundary, both ways; every
// extreme ray of the recession cone {d : A·d <= 0} lies along one of them.
function boundaryDirections(lines: Lines, tol: number): Array<[number, number]> {
  const directions: Array<[number, number]> = [];
  for (const [A, B] of lines) {
    const norm = Math.hypot(A, B);
    if (norm <= tol) continue;
    directions.push([-B / norm, A / norm], [B / norm, -A / norm]);
  }
  return directions;
}

function hasNontrivialRecessionDirection(lines: Lines, tol = 1e-6): boolean {
  // The recession cone of a 2D region is nontrivial iff one of its boundary
  // directions satisfies every constraint.
  return boundaryDirections(lines, tol).some(([dx, dy]) => lines.every(([A2, B2]) => A2 * dx + B2 * dy <= tol));
}

export function classifyRegion(lines: Lines, vertices: Vertices): RegionKind {
  if (lines.length === 0) {
    return "degenerate";
  }

  if (vertices.length >= 3) {
    // 3+ vertices alone do not imply boundedness: the region can still
    // recede along a direction in its recession cone.
    return hasNontrivialRecessionDirection(lines) ? "unbounded" : "bounded";
  }

  const feasiblePoint = findFeasiblePoint(lines);
  if (!feasiblePoint) {
    return "empty";
  }

  return "degenerate";
}

export function verticesFromLines(lines: Lines, tol = 1e-6): Vertices {
  const intersections: Vertices = [];
  const n = lines.length;

  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const point = intersectLines(lines[i]!, lines[j]!, tol);
      if (point && satisfiesLines(point, lines, tol)) intersections.push(point);
    }
  }

  if (intersections.length === 0) return [];

  const unique: Vertices = [];
  intersections.forEach(([x, y]) => {
    const existing = unique.find(([ux, uy]) => Math.hypot(ux - x, uy - y) < tol);
    if (!existing) unique.push([x, y]);
  });

  if (unique.length <= 2) {
    return unique.map(([x, y]) => [x, y]);
  }

  const center = centroid(unique);
  return unique
    .map(([x, y]) => ({
      angle: Math.atan2(y - center[1], x - center[0]),
      point: [x, y] as [number, number],
    }))
    .sort((a, b) => a.angle - b.angle)
    .map(({ point }) => point);
}

export interface BoundaryRay {
  start: [number, number];
  direction: [number, number];
}

// Clip the ray start + t*direction (t > 0) to the box: the farthest boundary hit, or null when the ray never enters it.
const RAY_CLIP_EPS = 1e-10;
export function clipRayToBoundingBox(start: Vec, direction: Vec, bounds: BoundingBox): [Vec, Vec] | null {
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

export function buildOpenBoundaryRays(points: Vertices): BoundaryRay[] {
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

function intersectOpenBoundaryRays(rays: BoundaryRay[], lines: Lines, tol = 1e-6): [number, number] | null {
  if (rays.length !== 2) return null;
  const r1 = rays[0]!;
  const r2 = rays[1]!;
  const params = rayParams(r1.start, r1.direction, r2.start, r2.direction, tol);
  if (!params || params[0] < -tol || params[1] < -tol) return null;
  const point: [number, number] = [r1.start[0] + params[0] * r1.direction[0], r1.start[1] + params[0] * r1.direction[1]];
  return satisfiesLines(point, lines, tol) ? point : null;
}

function intersectRayWithSegment(ray: BoundaryRay, segStart: Vertices[number], segEnd: Vertices[number], tol = 1e-6): [number, number] | null {
  const params = rayParams(ray.start, ray.direction, segStart, [segEnd[0] - segStart[0], segEnd[1] - segStart[1]], tol);
  if (!params || params[0] < -tol || params[1] < -tol || params[1] > 1 + tol) return null;
  return [ray.start[0] + params[0] * ray.direction[0], ray.start[1] + params[0] * ray.direction[1]];
}

function intersectSegmentWithLine(segStart: Vertices[number], segEnd: Vertices[number], line: Lines[number], tol = 1e-6): [number, number] | null {
  const [sx, sy] = segStart;
  const sdx = segEnd[0] - segStart[0];
  const sdy = segEnd[1] - segStart[1];
  const [A, B, C] = line;

  const denom = A * sdx + B * sdy;
  if (Math.abs(denom) < tol) return null;

  const t = (C - A * sx - B * sy) / denom;
  if (t <= tol || t >= 1 - tol) return null;

  return [sx + t * sdx, sy + t * sdy];
}

function terminalSegmentClosesAgainstNonAdjacentConstraint(points: Vertices, terminalSegmentIndex: number, lines: Lines, tol = 1e-6): boolean {
  const segStart = points[terminalSegmentIndex]!;
  const segEnd = points[terminalSegmentIndex + 1]!;

  for (let i = 0; i < lines.length; i++) {
    // Skip the segment's own line and the lines of adjacent edges, which all
    // pass through one of the segment's endpoints. (Index arithmetic is not
    // reliable here: buildConstraintRep skips degenerate edges, so lines[i]
    // does not necessarily correspond to edge i.)
    const [A, B, C] = lines[i]!;
    if (Math.abs(A * segStart[0] + B * segStart[1] - C) <= tol || Math.abs(A * segEnd[0] + B * segEnd[1] - C) <= tol) {
      continue;
    }
    const intersection = intersectSegmentWithLine(segStart, segEnd, lines[i]!, tol);
    if (intersection && satisfiesLines(intersection, lines, tol)) {
      return true;
    }
  }

  return false;
}

export function hasOpenBoundaryClosure(points: Vertices, lines: Lines, tol = 1e-6): boolean {
  const rays = buildOpenBoundaryRays(points);
  if (intersectOpenBoundaryRays(rays, lines, tol)) return true;
  if (points.length < 4) return false;

  // Test each ray against every segment except its own adjacent one
  // (segment 0 for the start ray, segment points.length - 2 for the end
  // ray); hits at the shared vertex of a neighboring segment are already
  // rejected by the tRay >= -tol check since that vertex lies behind the ray.
  const startRay = rays[0]!;
  const endRay = rays[1]!;
  for (let i = 1; i < points.length - 1; i++) {
    if (intersectRayWithSegment(startRay, points[i]!, points[i + 1]!, tol)) return true;
  }
  for (let i = 0; i < points.length - 2; i++) {
    if (intersectRayWithSegment(endRay, points[i]!, points[i + 1]!, tol)) return true;
  }

  return [0, points.length - 2].some((index) => terminalSegmentClosesAgainstNonAdjacentConstraint(points, index, lines, tol));
}

export function isObjectiveDirectionUnbounded(lines: Lines, objective: Vec, tol = 1e-6): boolean {
  if (lines.length === 0) {
    return false;
  }

  const [cx, cy] = objective;
  const objectiveNorm = Math.hypot(cx, cy);
  if (objectiveNorm <= tol) {
    return false;
  }

  const candidateDirections = boundaryDirections(lines, tol);
  candidateDirections.push([cx / objectiveNorm, cy / objectiveNorm]);
  // `!(… <= tol)` rather than `> tol` so a NaN dot still falls through to the
  // constraint test, as it always has
  return candidateDirections.some(([dx, dy]) => !(cx * dx + cy * dy <= tol) && lines.every(([A, B]) => A * dx + B * dy <= tol));
}
