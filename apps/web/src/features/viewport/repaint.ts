import type { ViewportRenderSnapshot } from "./types";

// Which render layers a change repaints. setState derives a set from the fields a patch changes
// (see the slices' *_DIRTY tables) and a snapshot change names its own (see below); the
// scene repaints just those layers.
export type ViewportDirtyFlags = Partial<{
  grid: boolean;
  polytope: boolean;
  constraints: boolean;
  objective: boolean;
  trace: boolean;
  iterate: boolean;
}>;

/** What a field's change repaints: a fixed set, or one the state decides (see the slices' *_DIRTY tables). */
export type FieldDirty<S> = ViewportDirtyFlags | ((state: S) => ViewportDirtyFlags);

// Repaint everything: a snapshot change that re-poses every layer.
const ALL_VIEWPORT_DIRTY: ViewportDirtyFlags = {
  grid: true,
  polytope: true,
  constraints: true,
  objective: true,
  trace: true,
  iterate: true,
};

// The layers anchored in world space, whose drawn heights follow the z scale and the 2D/3D transition.
export const WORLD_ANCHORED_DIRTY: ViewportDirtyFlags = { polytope: true, objective: true, trace: true, iterate: true };

/** What an invalidate asks for: a frame with the layers as they are, every layer rebuilt, or the layers the flags name rebuilt. */
export type Repaint = "frame" | "all" | ViewportDirtyFlags;

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
