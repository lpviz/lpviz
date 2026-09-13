import { computeFlatZ, type IteratePath } from "@/features/core/store";
import type { PointXY, PointXYZ } from "@lpviz/math/types";
import type { Polytope3Representation } from "@lpviz/polytope/polytope3";

type TraceEntry = IteratePath & {
  objectiveVector: PointXY | null;
};

type ZoomFitInputs = {
  vertices: PointXY[];
  iteratePath: IteratePath;
  originalIteratePath: IteratePath;
  iterateObjectiveVector: PointXY | null;
  originalIterateObjectiveVector: PointXY | null;
  traceBuffer: TraceEntry[];
  objectiveVector: PointXY | null;
  currentObjective: PointXY | null;
  objectiveHidden: boolean;
  problemMode: "2d" | "3d";
  polytope3: Polytope3Representation | null;
  objectiveVector3: PointXYZ | null;
};

// Accumulates min/max in a single pass with no intermediate arrays: the old
// per-point {x, y} objects plus Math.min(...spread) over every iterate both
// allocated heavily and, above ~125k z values (V8's argument limit), threw a
// RangeError that broke zoom-to-fit outright at high solver iteration counts.
export function collectZoomFitBounds({ vertices, iteratePath, originalIteratePath, iterateObjectiveVector, originalIterateObjectiveVector, traceBuffer, objectiveVector, currentObjective, objectiveHidden, problemMode, polytope3, objectiveVector3 }: ZoomFitInputs) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let hasZ = false;
  let valid = true;
  let count = 0;

  const addPoint = (x: number, y: number) => {
    count++;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      valid = false;
      return;
    }
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  const addPath = (path: IteratePath, objectiveOverride: PointXY | null) => {
    const { points, count, stride } = path;
    for (let i = 0; i < count; i++) {
      const base = i * stride;
      addPoint(points[base]!, points[base + 1]!);
      const z = computeFlatZ(points, base, stride, objectiveOverride);
      hasZ = true;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  };

  for (const vertex of vertices) {
    if (!vertex) {
      valid = false;
      break;
    }
    addPoint(vertex.x, vertex.y);
  }
  // use the objective each path was solved under, as the render layers do —
  // the current objectiveVector can differ mid-drag or after a solver error
  addPath(iteratePath, iterateObjectiveVector);
  addPath(originalIteratePath, originalIterateObjectiveVector);
  for (const traceEntry of traceBuffer) {
    addPath(traceEntry, traceEntry.objectiveVector);
  }

  if (!objectiveHidden) {
    if (objectiveVector) addPoint(objectiveVector.x, objectiveVector.y);
    if (currentObjective) addPoint(currentObjective.x, currentObjective.y);
  }

  // the 3-variable solid and objective carry real z coordinates
  if (problemMode === "3d") {
    const addPoint3 = (p: PointXYZ) => {
      addPoint(p.x, p.y);
      if (Number.isFinite(p.z)) {
        hasZ = true;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
    };
    if (polytope3) for (const v of polytope3.vertices) addPoint3(v);
    if (!objectiveHidden && objectiveVector3) addPoint3(objectiveVector3);
  }

  if (!valid || count === 0) {
    return null;
  }

  return {
    bounds: { minX, maxX, minY, maxY },
    zBounds: hasZ ? { minZ, maxZ } : undefined,
  };
}
