import type { BoundaryRay, RegionKind } from "@lpviz/math/geometry";
import type { Lines, Vertices } from "@lpviz/math/types";

type NonEmptyArray<T> = [T, ...T[]];
type NonEmptyLines = NonEmptyArray<Lines[number]>;

export interface PolytopeRepresentation {
  kind: RegionKind;
  inequalities: string[];
  lines: Lines;
  vertices: Vertices;
  boundaryRays: BoundaryRay[];
}

export function hasPolytopeLines(polytope: PolytopeRepresentation | null | undefined): polytope is PolytopeRepresentation & { lines: NonEmptyLines } {
  return Boolean(polytope && polytope.lines.length > 0);
}
