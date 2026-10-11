import { type PointXY } from "@lpviz/math/types";
import { type ViewportRenderSnapshot } from "@/features/viewport/types";
import { projectCanvasPointToWorldPlane } from "@lpviz/viewport/projection3d";
import { iterateHeight, type IteratePath } from "@/features/solver/types";
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

// One pass over every drawn point with no intermediate arrays: a path can hold 100k iterates,
// more than Math.min(...spread) accepts.
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

  for (const vertex of vertices) addPoint(vertex[0], vertex[1]);
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

// ---- the world rect the view shows ----

const CLIP_MARGIN_PX = 50;
const CLIP_MARGIN_UNITS = 50;

// The 2D view rect in world units, padded so geometry clipped against it
// never ends inside the frame.
export function visibleBounds2D(snap: ViewportRenderSnapshot): BoundingBox {
  const halfWidth = (snap.orthographic.right - snap.orthographic.left) / 2;
  const halfHeight = (snap.orthographic.top - snap.orthographic.bottom) / 2;
  const margin = CLIP_MARGIN_PX * snap.unitsPerPixel + CLIP_MARGIN_UNITS;
  return {
    minX: snap.target.x - halfWidth - margin,
    maxX: snap.target.x + halfWidth + margin,
    minY: snap.target.y - halfHeight - margin,
    maxY: snap.target.y + halfHeight + margin,
  };
}

// The floor the 3D view shows: the frame's corners and edge midpoints projected onto z = 0,
// padded; the whole clip box when none of them lands on the floor.
function visibleBounds3D(snap: ViewportRenderSnapshot): BoundingBox {
  const rect = { width: Math.max(1, snap.width), height: Math.max(1, snap.height) };
  const screenPoints = [
    { x: 0, y: 0 },
    { x: rect.width / 2, y: 0 },
    { x: rect.width, y: 0 },
    { x: 0, y: rect.height / 2 },
    { x: rect.width, y: rect.height / 2 },
    { x: 0, y: rect.height },
    { x: rect.width / 2, y: rect.height },
    { x: rect.width, y: rect.height },
  ];
  const floorPoints = screenPoints.map((p) => projectCanvasPointToWorldPlane(snap, rect, p, 0)).filter((p): p is PointXY => p !== null);
  if (floorPoints.length === 0) return UNBOUNDED_CLIP_BOUNDS;
  return {
    minX: Math.min(...floorPoints.map((p) => p.x)) - CLIP_MARGIN_UNITS,
    maxX: Math.max(...floorPoints.map((p) => p.x)) + CLIP_MARGIN_UNITS,
    minY: Math.min(...floorPoints.map((p) => p.y)) - CLIP_MARGIN_UNITS,
    maxY: Math.max(...floorPoints.map((p) => p.y)) + CLIP_MARGIN_UNITS,
  };
}

/** The world rect the view shows, padded, in either mode. */
export function visibleBounds(snap: ViewportRenderSnapshot): BoundingBox {
  return snap.mode === "2d" ? visibleBounds2D(snap) : visibleBounds3D(snap);
}

/** The snapshot fields the visible bounds follow, for a layer's dependency list. */
export const visibleBoundsDeps = (snap: ViewportRenderSnapshot): readonly unknown[] => [
  snap.mode,
  snap.orthographic.left,
  snap.orthographic.right,
  snap.orthographic.top,
  snap.orthographic.bottom,
  snap.target.x,
  snap.target.y,
  snap.unitsPerPixel,
  snap.width,
  snap.height,
  snap.scaleFactor,
];
