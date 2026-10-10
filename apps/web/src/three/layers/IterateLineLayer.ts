import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { iteratePositions } from "../helpers/iteratePositions";
import { PathRibbon } from "../helpers/pathRibbon";
import { phaseColorBytes } from "../helpers/phaseColors";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { PALETTE } from "../palette";
import { ZScaledLayer } from "./base/LayerBase";

const ITERATE_LINE_THICKNESS = 3;

// The iterate path renders as a screen-space ribbon (see pathRibbon.ts); phase coloring rides
// along as a per-point color texture, one draw call for the whole path.
export class IterateLineLayer extends ZScaledLayer {
  private readonly ribbon = new PathRibbon({ color: PALETTE.iterate, opacity: 1, linewidth: ITERATE_LINE_THICKNESS });
  readonly object3D = this.ribbon.mesh;
  override readonly renderPass = "trace" as const;
  override readonly invalidationKeys = ["iterate"] as const;

  constructor() {
    super();
    this.object3D.renderOrder = RENDER_ORDER.iterateLine;
  }

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.iteratePath, state.iteratePhases, snap.mode];
  }

  protected override visibleIn(state: State, snap: ViewportRenderSnapshot): boolean {
    return state.iteratePath.count >= 2 && super.visibleIn(state, snap);
  }

  protected rebuild(state: State): void {
    const path = state.iteratePath;

    const hasPhases = state.iteratePhases.length === path.count && state.iteratePhases.length > 0;
    // state z: zScale and the 2D/3D transition flattening are applied via
    // object3D.scale.z, so neither rebuilds the path
    this.ribbon.setPath(iteratePositions(path), path.count, hasPhases ? phaseColorBytes(state.iteratePhases) : null);
    this.object3D.visible = true;
  }

  dispose(): void {
    this.ribbon.dispose();
  }
}
