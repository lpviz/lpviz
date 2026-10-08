// What a set of constraints a·x ≤ b determines in the plane: feasible points, the vertices of the
// region, its kind, and whether an objective recedes along it. Expression orders are part of the
// solvers' input; keep them.

import { centroid } from "@lpviz/math/polygon";
import type { Constraint, Vec } from "@lpviz/math/types";
import type { PolytopeKind } from "./polytope";

const TOLERANCE = 1e-6;

function satisfiesAll(point: Vec, constraints: readonly Constraint[], tol: number): boolean {
  return constraints.every(([A, B, C]) => A * point[0] + B * point[1] <= C + tol);
}

// Where two constraint boundaries cross, or null when they are parallel within tol.
function intersectBoundaries([A1, B1, C1]: Constraint, [A2, B2, C2]: Constraint, tol: number): Vec | null {
  const det = A1 * B2 - A2 * B1;
  if (Math.abs(det) < tol) return null;
  return [(C1 * B2 - C2 * B1) / det, (A1 * C2 - A2 * C1) / det];
}

/** A point satisfying every constraint, or null when there is none (or no constraint). */
function findFeasiblePoint(constraints: readonly Constraint[], tol = TOLERANCE): Vec | null {
  if (constraints.length === 0) {
    return null;
  }

  const candidates: Vec[] = [[0, 0]];

  for (let i = 0; i < constraints.length; i++) {
    const [A, B, C] = constraints[i]!;
    // the foot of the normal on the boundary (the normals are unit length, see constraintsFromChain)
    const basePoint: Vec = [A * C, B * C];
    candidates.push(basePoint);
    for (const step of [1, 10, 100]) candidates.push([basePoint[0] - A * step, basePoint[1] - B * step]);
    for (let j = i + 1; j < constraints.length; j++) {
      const point = intersectBoundaries(constraints[i]!, constraints[j]!, tol);
      if (point) candidates.push(point);
    }
  }

  for (const candidate of candidates) {
    if (satisfiesAll(candidate, constraints, tol)) {
      return candidate;
    }
  }

  return null;
}

/** A point strictly inside every constraint, or null. */
export function findStrictFeasiblePoint(constraints: readonly Constraint[], tol = TOLERANCE): Vec | null {
  const feasiblePoint = findFeasiblePoint(constraints, tol);
  if (!feasiblePoint) {
    return null;
  }
  const strictlyInside = (p: Vec) => constraints.every(([A, B, C]) => A * p[0] + B * p[1] < C - tol);
  if (strictlyInside(feasiblePoint)) {
    return feasiblePoint;
  }

  const radii = [0.01, 0.1, 1, 10];
  const directions = 32;
  for (const radius of radii) {
    for (let i = 0; i < directions; i++) {
      const angle = (2 * Math.PI * i) / directions;
      const candidate: Vec = [feasiblePoint[0] + radius * Math.cos(angle), feasiblePoint[1] + radius * Math.sin(angle)];
      if (strictlyInside(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

// The unit directions along each constraint boundary, both ways; every
// extreme ray of the recession cone {d : A·d <= 0} lies along one of them.
function boundaryDirections(constraints: readonly Constraint[], tol: number): Vec[] {
  const directions: Vec[] = [];
  for (const [A, B] of constraints) {
    const norm = Math.hypot(A, B);
    if (norm <= tol) continue;
    directions.push([-B / norm, A / norm], [B / norm, -A / norm]);
  }
  return directions;
}

// The recession cone of a planar region is nontrivial iff one of its boundary
// directions satisfies every constraint.
function hasNontrivialRecessionDirection(constraints: readonly Constraint[], tol: number): boolean {
  return boundaryDirections(constraints, tol).some(([dx, dy]) => constraints.every(([A2, B2]) => A2 * dx + B2 * dy <= tol));
}

/**
 * The kind of region the constraints bound, given its vertices. For a closed chain three or more
 * vertices make a polygon that may still recede; fewer leave a point or segment ("degenerate") or
 * nothing. For an open chain the caller passes the vertices only when the chain closes on itself,
 * so any vertex means bounded and a feasible point otherwise means unbounded.
 */
export function classifyPolytope(constraints: readonly Constraint[], vertices: readonly Vec[], closedChain: boolean): PolytopeKind {
  // with no constraints the region is the whole plane, not infeasible
  if (constraints.length === 0) {
    return "degenerate";
  }
  if (closedChain) {
    if (vertices.length >= 3) {
      return hasNontrivialRecessionDirection(constraints, TOLERANCE) ? "unbounded" : "bounded";
    }
    return findFeasiblePoint(constraints) ? "degenerate" : "empty";
  }
  if (vertices.length > 0) return "bounded";
  return findFeasiblePoint(constraints) ? "unbounded" : "empty";
}

/** The vertices of the region, counterclockwise about their centroid. */
export function verticesFromConstraints(constraints: readonly Constraint[], tol = TOLERANCE): Vec[] {
  const intersections: Vec[] = [];
  const n = constraints.length;

  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const point = intersectBoundaries(constraints[i]!, constraints[j]!, tol);
      if (point && satisfiesAll(point, constraints, tol)) intersections.push(point);
    }
  }

  const unique: Vec[] = [];
  intersections.forEach(([x, y]) => {
    const existing = unique.find(([ux, uy]) => Math.hypot(ux - x, uy - y) < tol);
    if (!existing) unique.push([x, y]);
  });

  if (unique.length <= 2) {
    return unique;
  }

  const center = centroid(unique);
  return unique
    .map((point) => ({ angle: Math.atan2(point[1] - center[1], point[0] - center[0]), point }))
    .sort((a, b) => a.angle - b.angle)
    .map(({ point }) => point);
}

/** Whether maximizing `objective` over the region has no optimum: the region recedes along a direction the objective improves on. */
export function isObjectiveDirectionUnbounded(constraints: readonly Constraint[], objective: Vec, tol = TOLERANCE): boolean {
  if (constraints.length === 0) {
    return false;
  }

  const [cx, cy] = objective;
  const objectiveNorm = Math.hypot(cx, cy);
  if (objectiveNorm <= tol) {
    return false;
  }

  const candidateDirections = boundaryDirections(constraints, tol);
  candidateDirections.push([cx / objectiveNorm, cy / objectiveNorm]);
  // `!(… <= tol)` rather than `> tol` so a NaN dot still falls through to the constraint test
  return candidateDirections.some(([dx, dy]) => !(cx * dx + cy * dy <= tol) && constraints.every(([A, B]) => A * dx + B * dy <= tol));
}
