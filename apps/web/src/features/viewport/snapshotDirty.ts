import { ALL_VIEWPORT_DIRTY, WORLD_ANCHORED_DIRTY, type ViewportDirtyFlags } from "./dirtyFlags";
import type { ViewportRenderSnapshot } from "./types";

// Camera/layout changes don't go through the store's field-derived dirty flags
// (the camera lives in the render snapshot, not the store), so they derive their
// own repaint set from a prev/next snapshot diff. Panning in 2D only moves the
// grid (rounded to integer world units so sub-pixel pans don't thrash it); zoom
// or resize also moves the constant-screen-size objective head; a mode switch or
// a transition-z change repaints everything affected.
const getGridPanKey = (snapshot: ViewportRenderSnapshot): string => (snapshot.mode === "2d" ? `${Math.round(snapshot.target.x)}:${Math.round(snapshot.target.y)}` : "");

export function getSnapshotViewportDirtyFlags(prev: ViewportRenderSnapshot, next: ViewportRenderSnapshot): ViewportDirtyFlags {
  if (prev.mode !== next.mode) {
    return ALL_VIEWPORT_DIRTY;
  }
  if (prev.transitionZMultiplier !== next.transitionZMultiplier) {
    return WORLD_ANCHORED_DIRTY;
  }
  const sizeChanged = prev.width !== next.width || prev.height !== next.height;
  const zoomChanged =
    prev.scaleFactor !== next.scaleFactor ||
    prev.unitsPerPixel !== next.unitsPerPixel ||
    prev.gridSpacing !== next.gridSpacing ||
    prev.orthographic.left !== next.orthographic.left ||
    prev.orthographic.right !== next.orthographic.right ||
    prev.orthographic.top !== next.orthographic.top ||
    prev.orthographic.bottom !== next.orthographic.bottom ||
    prev.perspective.fov !== next.perspective.fov ||
    prev.perspective.aspect !== next.perspective.aspect ||
    prev.perspective.near !== next.perspective.near ||
    prev.perspective.far !== next.perspective.far;
  if (zoomChanged || sizeChanged) {
    return { grid: true, objective: true };
  }
  if (getGridPanKey(prev) !== getGridPanKey(next)) {
    return { grid: true };
  }
  return {};
}
