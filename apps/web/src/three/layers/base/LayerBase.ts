import type { ViewportDirtyFlags } from "@/features/core/store";
import type { Object3D } from "three";
import type { Layer, RenderPassName } from "../../Layer";
import type { SceneContext } from "../../SceneContext";

// Template-method base for data-driven layers. Replaces the ~230 lines of
// hand-written `PrevState` structs that every layer used to open `update()`
// with (`if (p && p.a === raw.a && …) return; this.prev = {…}`).
//
// A subclass declares the inputs whose reference change requires a rebuild via
// `dependencies(ctx)`; the base `Object.is`-compares the tuple against the
// previous one (the same reference-equality diff the hand-written code did) and
// calls `rebuild(ctx)` only on change. `everyFrame(ctx)` runs unconditionally —
// it formalizes the previously-implicit split where `object3D.scale.z` (and
// similar cheap transforms) must update every frame while geometry rebuilds
// only when its inputs change.
export abstract class LayerBase implements Layer {
  abstract readonly object3D: Object3D;
  readonly renderPass?: RenderPassName;
  abstract readonly invalidationKeys: readonly (keyof ViewportDirtyFlags)[];

  private deps: readonly unknown[] | null = null;

  update(ctx: SceneContext): void {
    this.everyFrame(ctx);
    const next = this.dependencies(ctx);
    if (this.deps && sameDeps(this.deps, next)) return;
    this.deps = next;
    this.rebuild(ctx);
  }

  /** Inputs compared with Object.is; a change triggers `rebuild`. */
  protected abstract dependencies(ctx: SceneContext): readonly unknown[];
  /** Rebuild geometry/visibility from current state. Runs only on change. */
  protected abstract rebuild(ctx: SceneContext): void;
  /** Cheap per-frame work (e.g. object3D.scale.z). Runs every update. */
  protected everyFrame(_ctx: SceneContext): void {}

  // Raw z is baked into the geometry; zScale and the 2D/3D flatten ride on
  // scale.z (the 2D ortho camera ignores z) so neither rebuilds geometry. Layers
  // whose z follows the view opt in by calling this from everyFrame.
  protected applyZScale(ctx: SceneContext): void {
    this.object3D.scale.z = (ctx.getState().zScale / 100) * ctx.getSnapshot().transitionZMultiplier;
  }

  abstract dispose(): void;
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}
