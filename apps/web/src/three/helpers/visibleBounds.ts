import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import type { BoundingBox } from "@lpviz/math/geometry";

const CLIP_MARGIN_PX = 50;
export const CLIP_MARGIN_UNITS = 50;

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
