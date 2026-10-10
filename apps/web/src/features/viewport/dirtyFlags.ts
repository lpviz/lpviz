// Which render layers a change repaints. setState derives a set from the fields a patch changes
// (see the slices' *_DIRTY tables), callers add to it, and the scene repaints just those layers.
export type ViewportDirtyFlags = Partial<{
  grid: boolean;
  polytope: boolean;
  constraints: boolean;
  objective: boolean;
  trace: boolean;
  iterate: boolean;
}>;

// Repaint everything — for whole-problem swaps (gallery load, shared-state
// import) and mode switches where deriving per-field flags would be noise.
export const ALL_VIEWPORT_DIRTY: ViewportDirtyFlags = {
  grid: true,
  polytope: true,
  constraints: true,
  objective: true,
  trace: true,
  iterate: true,
};

// The layers anchored in world space, whose drawn heights follow the z scale and the 2D/3D transition.
export const WORLD_ANCHORED_DIRTY: ViewportDirtyFlags = { polytope: true, objective: true, trace: true, iterate: true };

/** What an invalidate asks for: a layer update (every layer, or those the flags name) and a frame. */
export type ViewportInvalidation = { layers?: boolean; viewportDirty?: ViewportDirtyFlags | undefined };
