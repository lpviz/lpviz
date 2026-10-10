import type { Ray } from "@lpviz/math/bounds";
import type { Constraint, Vec } from "@lpviz/math/types";
import { constraintsFromChain } from "./constraints";
import { classifyPolytope, type PolytopeKind, verticesFromConstraints } from "./halfSpaces";
import { buildOpenBoundaryRays, hasOpenBoundaryClosure } from "./openChain";

/** The feasible region of the drawn problem: its constraints, their vertices, and the open chain's rays. */
export interface Polytope {
  kind: PolytopeKind;
  constraints: Constraint[];
  vertices: Vec[];
  boundaryRays: Ray[];
}

export function hasConstraints(polytope: Polytope | null | undefined): polytope is Polytope {
  return Boolean(polytope && polytope.constraints.length > 0);
}

const MAX_POINTS = 256;

/** The polytope the drawn points describe: a closed polygon, or an open chain whose end edges continue as rays. */
export function derivePolytope(points: readonly Vec[], closed: boolean): Polytope {
  if (points.length > MAX_POINTS) {
    throw new Error(`points.length > ${MAX_POINTS} not allowed`);
  }

  const constraints = constraintsFromChain(points, closed);

  if (closed) {
    const vertices = verticesFromConstraints(constraints);
    return { kind: classifyPolytope(constraints, vertices, true), constraints, vertices, boundaryRays: [] };
  }

  // a chain that closes on itself with a real polygon is bounded
  const allVertices = verticesFromConstraints(constraints);
  const vertices = hasOpenBoundaryClosure(points, constraints) && allVertices.length >= 3 ? allVertices : [];
  const kind = classifyPolytope(constraints, vertices, false);
  return { kind, constraints, vertices, boundaryRays: kind === "unbounded" ? buildOpenBoundaryRays(points) : [] };
}
