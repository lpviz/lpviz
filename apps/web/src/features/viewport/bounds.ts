import { iterateHeight, type IteratePath } from "@/features/solver/solverState";
import type { BoundingBox } from "@lpviz/math/bounds";
import type { Vec } from "@lpviz/math/types";

// How far an unbounded region is drawn and fitted: far beyond any zoom, inside float precision.
const UNBOUNDED_EXTENT = 5000;
export const UNBOUNDED_CLIP_BOUNDS: BoundingBox = { minX: -UNBOUNDED_EXTENT, maxX: UNBOUNDED_EXTENT, minY: -UNBOUNDED_EXTENT, maxY: UNBOUNDED_EXTENT };

type ZoomFitInputs = {
  vertices: Vec[];
  iteratePath: IteratePath;
  originalIteratePath: IteratePath;
  traceBuffer: IteratePath[];
  objectiveVector: Vec | null;
  currentObjective: Vec | null;
  objectiveHidden: boolean;
};

// Accumulates min/max in a single pass with no intermediate arrays: the old
// per-point {x, y} objects plus Math.min(...spread) over every iterate both
// allocated heavily and, above ~125k z values (V8's argument limit), threw a
// RangeError that broke zoom-to-fit outright at high solver iteration counts.
export function collectZoomFitBounds({ vertices, iteratePath, originalIteratePath, traceBuffer, objectiveVector, currentObjective, objectiveHidden }: ZoomFitInputs) {
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

  const addPath = (path: IteratePath) => {
    const { points, stride } = path;
    for (let i = 0; i < path.count; i++) {
      const base = i * stride;
      addPoint(points[base]!, points[base + 1]!);
      const z = iterateHeight(path, i);
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
    addPoint(vertex[0], vertex[1]);
  }
  addPath(iteratePath);
  addPath(originalIteratePath);
  for (const traceEntry of traceBuffer) {
    addPath(traceEntry);
  }

  if (!objectiveHidden) {
    if (objectiveVector) addPoint(objectiveVector[0], objectiveVector[1]);
    if (currentObjective) addPoint(currentObjective[0], currentObjective[1]);
  }

  if (!valid || count === 0) {
    return null;
  }

  return {
    bounds: { minX, maxX, minY, maxY },
    zBounds: hasZ ? { minZ, maxZ } : undefined,
  };
}
