import type { ViewportDirtyFlags } from "@/features/viewport/dirtyFlags";
import type { Object3D } from "three";

type LayerInvalidationKey = keyof ViewportDirtyFlags;

// The render passes in painter's-algorithm order — the single source of truth
// for both the pass names and the order SceneManager renders them in.
export const RENDER_PASSES = ["background", "transparent", "foreground", "vertices", "traceLines", "trace", "overlay"] as const;
export type RenderPassName = (typeof RENDER_PASSES)[number];

export type LayerRenderObject = {
  readonly object3D: Object3D;
  readonly pass: RenderPassName;
};

export interface Layer {
  readonly object3D: Object3D;
  readonly renderPass?: RenderPassName;
  readonly renderObjects?: readonly LayerRenderObject[];
  readonly invalidationKeys: readonly LayerInvalidationKey[];
  update(): void;
  dispose(): void;
}
