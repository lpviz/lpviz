import type { State } from "@/features/core/store";
import type { ViewportDirtyFlags } from "@/features/viewport/dirtyFlags";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import type { Object3D } from "three";

type LayerInvalidationKey = keyof ViewportDirtyFlags;

// Everything the scene draws, as a slot in a pass, in painter's order: the passes render in this
// order (each is its own scene), and within a pass a slot draws over the slots before it. The one
// place the scene's layering is stated.
const RENDER_SLOTS = {
  background: ["grid"],
  transparent: ["polytopeFill"],
  foreground: ["polytopeEdges", "objective", "constraintHighlight"],
  vertices: ["polytopeVertices"],
  trace: ["traceLine", "tracePoints"],
  iterate: ["ellipsoid", "iterateLine", "iteratePoints", "iterateRestartPoints", "iterateHighlight"],
  overlay: ["iterateStar", "solverStart"],
} as const;
export type RenderPassName = keyof typeof RENDER_SLOTS;
export type RenderSlot = (typeof RENDER_SLOTS)[RenderPassName][number];
export const RENDER_PASSES = Object.keys(RENDER_SLOTS) as readonly RenderPassName[];
/**
 * The three.js layer of the geometry that occludes the trace in 3D (the polytope's fill and
 * edges): what the trace cache primes its depth with, so that a chunk baked later is hidden where
 * the floor is in front of it exactly as a direct draw would be. The objective arrow is not on
 * it: it turns while the trace accumulates, and a stale arrow in the depth would notch every
 * later chunk, so the trace draws over the arrow instead, as it does in 2D.
 */
export const TRACE_OCCLUDER_LAYER = 1;
const slots = <T>(entry: (slot: RenderSlot, pass: RenderPassName, index: number) => T) =>
  Object.fromEntries(RENDER_PASSES.flatMap((pass) => RENDER_SLOTS[pass].map((slot, index) => [slot, entry(slot, pass, index)]))) as Record<RenderSlot, T>;
/** The pass a slot renders in. */
export const passOf = slots((_, pass) => pass);
/** A slot's order within its pass, which three sorts a scene by before anything else. */
export const renderOrderOf = slots((_, _pass, index) => index);

/** Put an object in its slot: drawn in the slot's order, never frustum-culled (the geometries' bounds are fake), hidden until its first draw. */
export function placeInSlot<T extends Object3D>(object: T, slot: RenderSlot): T {
  object.renderOrder = renderOrderOf[slot];
  object.frustumCulled = false;
  object.visible = false;
  return object;
}

/** A part a layer draws with: the object it puts in the scene and the GL resources it frees. */
export interface Drawable {
  readonly object3D: Object3D;
  dispose(): void;
}

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
  /** Bring the layer up to date with the frame's inputs, which the scene manager reads once per frame. */
  update(state: State, snap: ViewportRenderSnapshot): void;
  dispose(): void;
}
