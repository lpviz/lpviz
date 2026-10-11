import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { iteratePositions } from "../helpers/iteratePositions";
import { PathRibbon } from "../helpers/pathRibbon";
import { phaseColorsOf, phasesCovering } from "../helpers/phaseColors";
import { PALETTE, STROKE } from "../palette";
import { ZScaledLayer } from "./base/LayerBase";

// The iterate path renders as a screen-space ribbon (see pathRibbon.ts); phase coloring rides
// along as a per-point color texture, one draw call for the whole path.
export class IterateLineLayer extends ZScaledLayer {
  readonly slot = "iterateLine" as const;
  private readonly ribbon = new PathRibbon({ color: PALETTE.iterate, opacity: 1, linewidth: STROKE.iteratePath, slot: this.slot });
  readonly object3D = this.ribbon.mesh;
  override readonly invalidationKeys = ["iterate"] as const;

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.iteratePath, state.iteratePhases, snap.mode];
  }

  protected override visibleIn(state: State, snap: ViewportRenderSnapshot): boolean {
    return state.iteratePath.count >= 2 && super.visibleIn(state, snap);
  }

  protected rebuild(state: State): void {
    const path = state.iteratePath;
    const phases = phasesCovering(state.iteratePhases, path.count);
    // state z: zScale and the 2D/3D transition flattening are applied via
    // object3D.scale.z, so neither rebuilds the path
    this.ribbon.setPath(iteratePositions(path), path.count, phases ? phaseColorsOf(phases) : null);
  }

  dispose(): void {
    this.ribbon.dispose();
  }
}
