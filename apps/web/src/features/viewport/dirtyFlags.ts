// Field-change -> repaint mapping now lives in the store (FIELD_DIRTY /
// deriveViewportDirty). This module retains only the small viewport predicates
// that aren't dirty-flag derivation.
const VIEWPORT_UNBOUNDED_EXTENT = 5000;

export function isViewport3DState(state: { is3DMode: boolean; isTransitioning3D: boolean }) {
  return state.is3DMode || state.isTransitioning3D;
}

export function getViewportUnboundedClipBounds(): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  return {
    minX: -VIEWPORT_UNBOUNDED_EXTENT,
    maxX: VIEWPORT_UNBOUNDED_EXTENT,
    minY: -VIEWPORT_UNBOUNDED_EXTENT,
    maxY: VIEWPORT_UNBOUNDED_EXTENT,
  };
}
