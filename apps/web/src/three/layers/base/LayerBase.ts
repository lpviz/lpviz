import { getState, type State } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import type { Object3D } from "three";
import { viewShowsMode } from "../../helpers/sceneVisibility";
import type { Layer, LayerPlacement, RenderPassName } from "../../Layer";

// Template-method base for data-driven layers: a subclass declares the inputs whose reference
// change requires a rebuild via `dependencies()`, and the base `Object.is`-compares the tuple
// against the previous one and calls `rebuild()` only on change. `everyFrame()` runs
// unconditionally, for cheap transforms such as `object3D.scale.z` that must update every frame.
// A layer the view does not show (`visibleIn`) is hidden without a rebuild, and rebuilt when it
// shows again. The store and the render snapshot are read once per update and handed down.
export abstract class LayerBase implements Layer {
  abstract readonly object3D: Object3D;
  readonly renderPass: RenderPassName = "foreground";
  abstract readonly invalidationKeys: Layer["invalidationKeys"];

  private deps: readonly unknown[] | null = null;

  placements(): readonly LayerPlacement[] {
    return [{ object3D: this.object3D, pass: this.renderPass }];
  }

  update(): void {
    const state = getState();
    const snap = getViewportRenderSnapshot();
    this.everyFrame(state, snap);
    if (!this.visibleIn(state, snap)) {
      this.hide();
      this.deps = null;
      return;
    }
    const next = this.dependencies(state, snap);
    if (this.deps && sameDeps(this.deps, next)) return;
    this.deps = next;
    this.rebuild(state, snap);
  }

  /** Whether the view shows the layer at all; by default whenever the view shows the snapshot's mode. */
  protected visibleIn(state: State, snap: ViewportRenderSnapshot): boolean {
    return viewShowsMode(state, snap);
  }
  /** Take everything the layer draws off screen; a layer with more than `object3D` extends this. */
  protected hide(): void {
    this.object3D.visible = false;
  }
  /** Inputs compared with Object.is; a change triggers `rebuild`. */
  protected abstract dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[];
  /** Rebuild geometry/visibility from current state. Runs only on change. */
  protected abstract rebuild(state: State, snap: ViewportRenderSnapshot): void;
  /** Cheap per-frame work (e.g. object3D.scale.z). Runs every update. */
  protected everyFrame(_state: State, _snap: ViewportRenderSnapshot): void {}

  abstract dispose(): void;
}

// Raw z is baked into the geometry; zScale and the 2D/3D flatten ride on
// scale.z (the 2D ortho camera ignores z) so neither rebuilds geometry. Base
// for every layer whose z follows the view.
export abstract class ZScaledLayer extends LayerBase {
  protected override everyFrame(state: State, snap: ViewportRenderSnapshot): void {
    this.object3D.scale.z = (state.zScale / 100) * snap.transitionZMultiplier;
  }
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}
