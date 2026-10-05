import type { Vertices } from "@lpviz/math/types";
import { buildOpenBoundaryRays, classifyRegion, findFeasiblePoint, hasOpenBoundaryClosure, verticesFromLines } from "@lpviz/math/geometry";
import { buildConstraintRep } from "./constraintRep";
import type { PolytopeRepresentation } from "./polytopeTypes";

export function deriveRegionFromPoints(points: Vertices, completionMode: "closed" | "open"): PolytopeRepresentation {
  if (points.length > 256) {
    throw new Error("points.length > 256 not allowed");
  }

  const closed = completionMode === "closed";
  const { inequalities, lines } = buildConstraintRep(points, closed);

  if (!closed) {
    const allVertices = verticesFromLines(lines);
    const boundaryRays = buildOpenBoundaryRays(points);
    const feasiblePoint = findFeasiblePoint(lines);
    const hasClosure = hasOpenBoundaryClosure(points, lines);
    // With no constraints the region is the whole plane, not infeasible
    // (findFeasiblePoint returns null for an empty line set by design);
    // mirror classifyRegion's handling of the closed case.
    const kind: PolytopeRepresentation["kind"] = lines.length === 0 ? "degenerate" : hasClosure && allVertices.length >= 3 ? "bounded" : feasiblePoint ? "unbounded" : "empty";
    const vertices = hasClosure && allVertices.length >= 3 ? allVertices : [];

    return {
      kind,
      inequalities,
      vertices,
      lines,
      boundaryRays: kind === "unbounded" ? boundaryRays : [],
    };
  }

  const vertices = verticesFromLines(lines);
  const kind = classifyRegion(lines, vertices, true);

  return {
    kind,
    inequalities,
    vertices,
    lines,
    boundaryRays: [],
  };
}
