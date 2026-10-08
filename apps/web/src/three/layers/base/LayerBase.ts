import { getState } from "@/features/core/store";
import type { ViewportDirtyFlags } from "@/features/viewport/dirtyFlags";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { Group, type Object3D } from "three";
import type { Layer, RenderPassName } from "../../Layer";

// Template-method base for data-driven layers: a subclass declares the inputs whose reference
// change requires a rebuild via `dependencies()`, and the base `Object.is`-compares the tuple
// against the previous one and calls `rebuild()` only on change. `everyFrame()` runs
// unconditionally, for cheap transforms such as `object3D.scale.z` that must update every frame.
export abstract class LayerBase implements Layer {
  abstract readonly object3D: Object3D;
  readonly renderPass?: RenderPassName;
  abstract readonly invalidationKeys: readonly (keyof ViewportDirtyFlags)[];

  private deps: readonly unknown[] | null = null;

  update(): void {
    this.everyFrame();
    const next = this.dependencies();
    if (this.deps && sameDeps(this.deps, next)) return;
    this.deps = next;
    this.rebuild();
  }

  /** Inputs compared with Object.is; a change triggers `rebuild`. */
  protected abstract dependencies(): readonly unknown[];
  /** Rebuild geometry/visibility from current state. Runs only on change. */
  protected abstract rebuild(): void;
  /** Cheap per-frame work (e.g. object3D.scale.z). Runs every update. */
  protected everyFrame(): void {}

  abstract dispose(): void;
}

// Raw z is baked into the geometry; zScale and the 2D/3D flatten ride on
// scale.z (the 2D ortho camera ignores z) so neither rebuilds geometry. Base
// for every layer whose z follows the view.
export abstract class ZScaledLayer extends LayerBase {
  protected override everyFrame(): void {
    this.object3D.scale.z = (getState().zScale / 100) * getViewportRenderSnapshot().transitionZMultiplier;
  }
}

// A z-scaled layer whose object3D is a plain Group of the objects it manages.
export abstract class ZScaledGroupLayer extends ZScaledLayer {
  readonly object3D = new Group();
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}
