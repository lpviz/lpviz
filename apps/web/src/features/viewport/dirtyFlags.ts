// Which render layers a change repaints. setState derives a set from the fields a patch changes
// (see the slices' *_DIRTY tables) and a snapshot change names its own (see snapshotDirty); the
// scene repaints just those layers.
export type ViewportDirtyFlags = Partial<{
  grid: boolean;
  polytope: boolean;
  constraints: boolean;
  objective: boolean;
  trace: boolean;
  iterate: boolean;
}>;

// Repaint everything: a snapshot change that re-poses every layer.
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

/** What an invalidate asks for: a frame with the layers as they are, every layer rebuilt, or the layers the flags name rebuilt. */
export type Repaint = "frame" | "all" | ViewportDirtyFlags;
