import { UNBOUNDED_CLIP_BOUNDS } from "@/features/viewport/bounds";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import type { BoundingBox } from "@lpviz/math/bounds";
import type { PointXY } from "@lpviz/math/types";
import { projectCanvasPointToWorldPlane } from "@lpviz/viewport/projection3d";

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
