import { solveDenseSystem } from "@lpviz/math/lapack";
import type { PointXYZ } from "@lpviz/math/types";
import { formatConstraintNumber } from "./constraintRep";

/** A half-space `a*x + b*y + c*z <= d` stored as `[a, b, c, d]` with (a, b, c) unit length. */
export type Plane3 = number[];

export interface Face3 {
  planeIndex: number;
  vertexIndices: number[];
}

export interface Polytope3Representation {
  kind: "bounded" | "empty" | "degenerate";
  planes: Plane3[];
  vertices: PointXYZ[];
  faces: Face3[];
  inequalities: string[];
}

function subtract(a: PointXYZ, b: PointXYZ): PointXYZ {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: PointXYZ, b: PointXYZ): PointXYZ {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: PointXYZ, b: PointXYZ): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function norm(a: PointXYZ): number {
  return Math.hypot(a.x, a.y, a.z);
}

/**
 * Extrude 2D base lines `[A, B, C]` (meaning `A*x + B*y <= C`, unit-normalized)
 * into vertical side planes, closed below by `z >= 0` and above by `z <= height`.
 */
export function buildPrismPlanes(baseLines: number[][], height: number): Plane3[] {
  const planes: Plane3[] = baseLines.map(([A, B, C]) => [A, B, 0, C]);
  planes.push([0, 0, -1, 0]);
  planes.push([0, 0, 1, height]);
  return planes;
}

function satisfiesAllPlanes(planes: Plane3[], point: PointXYZ, tol: number): boolean {
  const scale = 1 + Math.abs(point.x) + Math.abs(point.y) + Math.abs(point.z);
  return planes.every(([a, b, c, d]) => a * point.x + b * point.y + c * point.z <= d + tol * scale);
}

/**
 * Brute-force vertex enumeration: intersect every triple of planes and keep
 * the intersections satisfying all half-spaces. Plane counts are small
 * (< 40), so the C(m, 3) sweep is fine.
 */
export function enumerateVertices3(planes: Plane3[], tol = 1e-9): PointXYZ[] {
  const m = planes.length;
  const matrix = new Float64Array(9);
  const rhs = new Float64Array(3);
  const solution = new Float64Array(3);
  const luScratch = new Float64Array(9);
  const feasibilityTol = 1e-7;
  const dedupTol = 1e-7;
  const vertices: PointXYZ[] = [];

  for (let i = 0; i < m - 2; i++) {
    for (let j = i + 1; j < m - 1; j++) {
      for (let k = j + 1; k < m; k++) {
        const [a1, b1, c1, d1] = planes[i];
        const [a2, b2, c2, d2] = planes[j];
        const [a3, b3, c3, d3] = planes[k];

        const det = a1 * (b2 * c3 - b3 * c2) - b1 * (a2 * c3 - a3 * c2) + c1 * (a2 * b3 - a3 * b2);
        if (Math.abs(det) < tol) continue;

        matrix.set([a1, b1, c1, a2, b2, c2, a3, b3, c3]);
        rhs.set([d1, d2, d3]);
        try {
          solveDenseSystem(matrix, 3, rhs, solution, luScratch);
        } catch {
          continue;
        }

        const point: PointXYZ = { x: solution[0], y: solution[1], z: solution[2] };
        if (!satisfiesAllPlanes(planes, point, feasibilityTol)) continue;

        const existing = vertices.find((v) => norm(subtract(v, point)) < dedupTol);
        if (!existing) vertices.push(point);
      }
    }
  }

  return vertices;
}

/**
 * Group vertices onto their supporting planes and order each face as a convex
 * polygon, counter-clockwise when viewed from outside (Newell normal along
 * the outward plane normal).
 */
export function assembleFaces3(planes: Plane3[], vertices: PointXYZ[], tol = 1e-7): Face3[] {
  const faces: Face3[] = [];

  planes.forEach((plane, planeIndex) => {
    const [a, b, c, d] = plane;
    const normal: PointXYZ = { x: a, y: b, z: c };

    const memberIndices: number[] = [];
    vertices.forEach((vertex, vertexIndex) => {
      if (Math.abs(dot(normal, vertex) - d) < tol * (1 + Math.abs(d))) {
        memberIndices.push(vertexIndex);
      }
    });
    if (memberIndices.length < 3) return;

    const faceCentroid = centroid3(memberIndices.map((index) => vertices[index]));

    // Orthonormal in-plane basis (u, w): start from the axis least aligned
    // with the normal so the cross product is well conditioned.
    const absA = Math.abs(a);
    const absB = Math.abs(b);
    const absC = Math.abs(c);
    const reference: PointXYZ = absA <= absB && absA <= absC ? { x: 1, y: 0, z: 0 } : absB <= absC ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    const uRaw = cross(normal, reference);
    const uNorm = norm(uRaw);
    if (uNorm < tol) return;
    const u: PointXYZ = { x: uRaw.x / uNorm, y: uRaw.y / uNorm, z: uRaw.z / uNorm };
    const w = cross(normal, u);

    const ordered = memberIndices
      .map((index) => {
        const offset = subtract(vertices[index], faceCentroid);
        return { index, angle: Math.atan2(dot(offset, w), dot(offset, u)) };
      })
      .sort((first, second) => first.angle - second.angle)
      .map(({ index }) => index);

    // Orient counter-clockwise from outside: the loop's Newell normal must
    // point along the outward plane normal.
    const newell = newellNormal(ordered.map((index) => vertices[index]));
    if (dot(newell, normal) < 0) ordered.reverse();

    faces.push({ planeIndex, vertexIndices: ordered });
  });

  return faces;
}

function newellNormal(loop: PointXYZ[]): PointXYZ {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < loop.length; i++) {
    const current = loop[i];
    const next = loop[(i + 1) % loop.length];
    x += (current.y - next.y) * (current.z + next.z);
    y += (current.z - next.z) * (current.x + next.x);
    z += (current.x - next.x) * (current.y + next.y);
  }
  return { x, y, z };
}

function verticesSpanThreeDimensions(vertices: PointXYZ[], tol = 1e-7): boolean {
  if (vertices.length < 4) return false;
  const origin = vertices[0];

  let firstDirection: PointXYZ | null = null;
  let firstNorm = 0;
  for (let i = 1; i < vertices.length; i++) {
    const diff = subtract(vertices[i], origin);
    const diffNorm = norm(diff);
    if (diffNorm > firstNorm) {
      firstDirection = diff;
      firstNorm = diffNorm;
    }
  }
  if (!firstDirection || firstNorm < tol) return false;

  let bestCross: PointXYZ | null = null;
  let bestCrossNorm = 0;
  for (let i = 1; i < vertices.length; i++) {
    const candidate = cross(firstDirection, subtract(vertices[i], origin));
    const candidateNorm = norm(candidate);
    if (candidateNorm > bestCrossNorm) {
      bestCross = candidate;
      bestCrossNorm = candidateNorm;
    }
  }
  if (!bestCross || bestCrossNorm < tol * firstNorm) return false;

  const planeNormal: PointXYZ = { x: bestCross.x / bestCrossNorm, y: bestCross.y / bestCrossNorm, z: bestCross.z / bestCrossNorm };
  return vertices.some((vertex, index) => index > 0 && Math.abs(dot(planeNormal, subtract(vertex, origin))) > tol);
}

/**
 * Classify the intersection of the given half-spaces and assemble its faces.
 *
 * Callers only ever construct bounded shapes (prisms plus added cuts), so the
 * feasible set is always bounded whenever it is full-dimensional; no
 * "unbounded" classification is needed here.
 */
export function derivePolytope3(planes: Plane3[]): Polytope3Representation {
  const inequalities = planes.map(formatInequality3);
  const vertices = enumerateVertices3(planes);

  if (vertices.length === 0) {
    return { kind: "empty", planes, vertices, faces: [], inequalities };
  }

  if (!verticesSpanThreeDimensions(vertices)) {
    return { kind: "degenerate", planes, vertices, faces: [], inequalities };
  }

  return { kind: "bounded", planes, vertices, faces: assembleFaces3(planes, vertices), inequalities };
}

/**
 * Convex hull of a small point set, as the same representation the H-rep
 * pipeline produces — this is the 3D editor's primary derivation (vertices
 * are the source of truth, like the 2D editor's V-rep).
 *
 * Brute force over supporting planes: every point triple whose plane has all
 * points on one side is a face plane. Exact for the editor's point counts
 * (tens), and — unlike triangulating hulls — it yields one face per plane
 * with coplanar points merged, which is what face picking and push/pull need.
 *
 * `vertices` echoes ALL input points in input order (so callers can keep
 * stable drag handles, including points lying on or inside the hull); face
 * rings only include each face's extreme points.
 */
export function deriveHullFromPoints3(points: PointXYZ[]): Polytope3Representation {
  const degenerate = (): Polytope3Representation => ({ kind: "degenerate", planes: [], vertices: points, faces: [], inequalities: [] });
  if (points.length < 4) return degenerate();

  const tol = 1e-7;
  const planes: Plane3[] = [];
  const faces: Face3[] = [];

  for (let i = 0; i < points.length - 2; i++) {
    for (let j = i + 1; j < points.length - 1; j++) {
      for (let k = j + 1; k < points.length; k++) {
        const pi = points[i];
        const normalRaw = cross(subtract(points[j], pi), subtract(points[k], pi));
        const normalNorm = norm(normalRaw);
        if (normalNorm < tol) continue; // collinear triple

        let normal: PointXYZ = { x: normalRaw.x / normalNorm, y: normalRaw.y / normalNorm, z: normalRaw.z / normalNorm };
        let d = dot(normal, pi);

        let minOffset = 0;
        let maxOffset = 0;
        for (const point of points) {
          const offset = dot(normal, point) - d;
          if (offset < minOffset) minOffset = offset;
          if (offset > maxOffset) maxOffset = offset;
        }
        const scale = tol * (1 + Math.abs(d));
        if (maxOffset > scale && minOffset < -scale) continue; // cuts through the set
        if (maxOffset > scale) {
          // points on the positive side: flip so the hull is on the <= side
          normal = { x: -normal.x, y: -normal.y, z: -normal.z };
          d = -d;
        }

        if (planes.some((existing) => dot({ x: existing[0], y: existing[1], z: existing[2] }, normal) > 1 - 1e-9 && Math.abs(existing[3] - d) < scale + 1e-9)) continue;

        const memberIndices: number[] = [];
        for (let index = 0; index < points.length; index++) {
          if (Math.abs(dot(normal, points[index]) - d) < tol * (1 + Math.abs(d))) memberIndices.push(index);
        }
        const ring = faceRingIndices(points, memberIndices, normal);
        if (ring.length < 3) continue;

        planes.push([normal.x, normal.y, normal.z, d]);
        faces.push({ planeIndex: planes.length - 1, vertexIndices: ring });
      }
    }
  }

  if (faces.length < 4) return degenerate();
  return { kind: "bounded", planes, vertices: points, faces, inequalities: planes.map(formatInequality3) };
}

/**
 * Order a face's extreme points into a convex ring, counter-clockwise when
 * viewed from outside (Newell normal along the outward plane normal).
 * Non-extreme coplanar members (e.g. a vertex just inserted onto the face)
 * are excluded via a 2D in-plane convex hull.
 */
function faceRingIndices(points: PointXYZ[], memberIndices: number[], normal: PointXYZ): number[] {
  if (memberIndices.length < 3) return [];

  // in-plane orthonormal basis, seeded from the axis least aligned with the normal
  const absA = Math.abs(normal.x);
  const absB = Math.abs(normal.y);
  const absC = Math.abs(normal.z);
  const reference: PointXYZ = absA <= absB && absA <= absC ? { x: 1, y: 0, z: 0 } : absB <= absC ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  const uRaw = cross(normal, reference);
  const uNorm = norm(uRaw);
  if (uNorm < 1e-12) return [];
  const u: PointXYZ = { x: uRaw.x / uNorm, y: uRaw.y / uNorm, z: uRaw.z / uNorm };
  const w = cross(normal, u);

  // monotone-chain hull over the projected members
  const projected = memberIndices.map((index) => ({ index, a: dot(points[index], u), b: dot(points[index], w) })).sort((first, second) => first.a - second.a || first.b - second.b);
  const crossZ = (o: { a: number; b: number }, p: { a: number; b: number }, q: { a: number; b: number }) => (p.a - o.a) * (q.b - o.b) - (p.b - o.b) * (q.a - o.a);
  const lower: typeof projected = [];
  for (const point of projected) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], point) <= 1e-12) lower.pop();
    lower.push(point);
  }
  const upper: typeof projected = [];
  for (let index = projected.length - 1; index >= 0; index--) {
    const point = projected[index];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], point) <= 1e-12) upper.pop();
    upper.push(point);
  }
  const ring = [...lower.slice(0, -1), ...upper.slice(0, -1)].map((entry) => entry.index);
  if (ring.length < 3) return [];

  const newell = newellNormal(ring.map((index) => points[index]));
  if (dot(newell, normal) < 0) ring.reverse();
  return ring;
}

export interface Edge3 {
  a: number;
  b: number;
  planeIndices: [number, number];
}

/**
 * Undirected edges of an assembled polytope: each pair of vertices that are
 * consecutive on two distinct faces, tagged with those faces' plane indices.
 */
export function enumerateEdges3(faces: Face3[]): Edge3[] {
  const byKey = new Map<string, { a: number; b: number; planes: number[] }>();
  for (const face of faces) {
    const ring = face.vertexIndices;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const entry = byKey.get(key);
      if (entry) {
        if (!entry.planes.includes(face.planeIndex)) entry.planes.push(face.planeIndex);
      } else {
        byKey.set(key, { a: Math.min(a, b), b: Math.max(a, b), planes: [face.planeIndex] });
      }
    }
  }
  const edges: Edge3[] = [];
  for (const { a, b, planes } of byKey.values()) {
    if (planes.length === 2) edges.push({ a, b, planeIndices: [planes[0], planes[1]] });
  }
  return edges;
}

/**
 * Half-space that bevels the edge between two faces: outward normal is the
 * (normalized) sum of the adjacent face normals, offset pulled in by `inset`
 * from the edge midpoint. Null when the faces are anti-parallel.
 */
export function bevelPlaneForEdge(edgeMidpoint: PointXYZ, firstPlane: Plane3, secondPlane: Plane3, inset: number): Plane3 | null {
  const summed: PointXYZ = { x: firstPlane[0] + secondPlane[0], y: firstPlane[1] + secondPlane[1], z: firstPlane[2] + secondPlane[2] };
  const summedNorm = norm(summed);
  if (summedNorm < 1e-9) return null;
  const normal: PointXYZ = { x: summed.x / summedNorm, y: summed.y / summedNorm, z: summed.z / summedNorm };
  return [normal.x, normal.y, normal.z, dot(normal, edgeMidpoint) - inset];
}

/**
 * Whether the half-space intersection is bounded. The recession cone
 * `{d : A d <= 0}` of a 3D polyhedron is nontrivial iff it contains an
 * extreme ray, and every extreme ray lies along the intersection of two of
 * the cone's facets — i.e. along ±cross(n_i, n_j) for some plane pair — or,
 * when fewer than two independent normals exist, along a direction in a
 * single plane's boundary. Checking those candidate directions is exact.
 */
export function isBounded3(planes: Plane3[], tol = 1e-9): boolean {
  const normals: PointXYZ[] = planes.map(([a, b, c]) => ({ x: a, y: b, z: c }));
  const recedes = (direction: PointXYZ): boolean => {
    const directionNorm = norm(direction);
    if (directionNorm < tol) return false;
    const unit: PointXYZ = { x: direction.x / directionNorm, y: direction.y / directionNorm, z: direction.z / directionNorm };
    return normals.every((normal) => dot(normal, unit) <= tol);
  };

  // fewer than 3 planes can never bound R³
  if (planes.length < 3) return false;

  for (let i = 0; i < normals.length; i++) {
    // a lone facet direction: -n_i always recedes unless some other normal opposes it
    if (recedes({ x: -normals[i].x, y: -normals[i].y, z: -normals[i].z })) return false;
    for (let j = i + 1; j < normals.length; j++) {
      const ray = cross(normals[i], normals[j]);
      if (recedes(ray) || recedes({ x: -ray.x, y: -ray.y, z: -ray.z })) return false;
    }
  }
  return true;
}

/** Human-readable inequality, mirroring the 2D formatConstraint conventions. */
export function formatInequality3(plane: Plane3): string {
  const [a, b, c, d] = plane;
  const terms: Array<[number, string]> = [
    [formatConstraintNumber(a), "x"],
    [formatConstraintNumber(b), "y"],
    [formatConstraintNumber(c), "z"],
  ];
  const normalizedD = formatConstraintNumber(d);
  const inequalitySign = "≤";

  let leftSide = "";
  for (const [coefficient, variable] of terms) {
    if (coefficient === 0) continue;
    const magnitude = Math.abs(coefficient);
    const term = magnitude === 1 ? variable : `${magnitude}${variable}`;
    if (leftSide === "") {
      leftSide = coefficient < 0 ? `-${term}` : term;
    } else {
      leftSide += coefficient < 0 ? ` - ${term}` : ` + ${term}`;
    }
  }

  if (leftSide === "") {
    return `0 ${inequalitySign} ${normalizedD}`;
  }

  return `${leftSide} ${inequalitySign} ${normalizedD}`;
}

/** Arithmetic mean of the given points. */
export function centroid3(vertices: PointXYZ[]): PointXYZ {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const vertex of vertices) {
    x += vertex.x;
    y += vertex.y;
    z += vertex.z;
  }
  const count = vertices.length || 1;
  return { x: x / count, y: y / count, z: z / count };
}

/**
 * Half-space that truncates the corner at `vertex`: outward normal points
 * from the centroid through the vertex, offset pulled in by `inset`.
 */
export function chamferPlaneForVertex(vertex: PointXYZ, centroid: PointXYZ, inset: number): Plane3 | null {
  const direction = subtract(vertex, centroid);
  const directionNorm = norm(direction);
  if (directionNorm < 1e-9) return null;

  const normal: PointXYZ = { x: direction.x / directionNorm, y: direction.y / directionNorm, z: direction.z / directionNorm };
  return [normal.x, normal.y, normal.z, dot(normal, vertex) - inset];
}

/**
 * Clamp a dragged face offset so the polytope stays bounded. If `targetD` is
 * feasible it is returned as-is; otherwise bisect between the current offset
 * and the target, then back off by `minSeparation` toward the feasible side.
 */
export function clampFaceOffset(planes: Plane3[], planeIndex: number, targetD: number, minSeparation = 0.05): number {
  const currentD = planes[planeIndex][3];
  const withOffset = (d: number): Plane3[] => planes.map((plane, index) => (index === planeIndex ? [plane[0], plane[1], plane[2], d] : plane));
  const isBounded = (d: number): boolean => derivePolytope3(withOffset(d)).kind === "bounded";

  if (isBounded(targetD)) return targetD;
  if (!isBounded(currentD)) return currentD;

  let feasibleD = currentD;
  let infeasibleD = targetD;
  for (let iteration = 0; iteration < 24; iteration++) {
    const midpoint = (feasibleD + infeasibleD) / 2;
    if (isBounded(midpoint)) {
      feasibleD = midpoint;
    } else {
      infeasibleD = midpoint;
    }
  }

  const towardFeasible = Math.sign(currentD - targetD) || 1;
  const backedOff = feasibleD + towardFeasible * minSeparation;
  return towardFeasible > 0 ? Math.min(backedOff, currentD) : Math.max(backedOff, currentD);
}

/**
 * Strictly interior point, or null if none is readily available. For bounded
 * full-dimensional polytopes the vertex centroid is strictly interior, so
 * null only happens for degenerate inputs.
 */
export function interiorPoint3(planes: Plane3[], vertices: PointXYZ[]): PointXYZ | null {
  if (vertices.length === 0) return null;
  const candidate = centroid3(vertices);
  const strictlyFeasible = planes.every(([a, b, c, d]) => d - (a * candidate.x + b * candidate.y + c * candidate.z) > 1e-9);
  return strictlyFeasible ? candidate : null;
}
