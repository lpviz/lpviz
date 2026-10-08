import type { ViewportDirtyFlags } from "@/features/viewport/dirtyFlags";
import type { Object3D } from "three";

type LayerInvalidationKey = keyof ViewportDirtyFlags;

// The render passes in painter's-algorithm order — the single source of truth
// for both the pass names and the order SceneManager renders them in.
export const RENDER_PASSES = ["background", "transparent", "foreground", "vertices", "traceLines", "trace", "overlay"] as const;
export type RenderPassName = (typeof RENDER_PASSES)[number];

/** One of a layer's objects and the pass it renders in. */
export type LayerPlacement = {
  readonly object3D: Object3D;
  readonly pass: RenderPassName;
};

export interface Layer {
  /** the objects the layer draws, each in its pass */
  placements(): readonly LayerPlacement[];
  /** the dirty flags that make the layer update; a flagless invalidate updates every layer */
  readonly invalidationKeys: readonly LayerInvalidationKey[];
  update(): void;
  dispose(): void;
}
