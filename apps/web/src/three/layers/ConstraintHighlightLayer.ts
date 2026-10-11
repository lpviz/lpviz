import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { clipLineToBoundingBox } from "@lpviz/math/bounds";
import { hasConstraints } from "@lpviz/polytope/polytope";
import { FatLine } from "../helpers/fatLine";
import { rendersPlanarDrawing } from "../helpers/sceneVisibility";
import { visibleBounds, visibleBoundsDeps } from "../helpers/visibleBounds";
import { PALETTE, STROKE } from "../palette";
import { LayerBase } from "./base/LayerBase";

export class ConstraintHighlightLayer extends LayerBase {
  readonly slot = "constraintHighlight" as const;
  private readonly line = new FatLine({ color: PALETTE.accent, linewidth: STROKE.constraintHighlight, slot: this.slot });
  readonly object3D = this.line.object3D;
  // "grid" fires on zoom/resize/pan, which move the visible bounds this
  // layer clips against; the dependency check below keeps updates cheap.
  override readonly invalidationKeys = ["constraints", "grid"] as const;

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.completionMode, state.highlightIndex, state.polytope, ...visibleBoundsDeps(snap)];
  }

  protected override visibleIn(state: State, snap: ViewportRenderSnapshot): boolean {
    return state.completionMode !== "draft" && state.highlightIndex !== null && hasConstraints(state.polytope) && rendersPlanarDrawing(state, snap);
  }

  protected rebuild(state: State, snap: ViewportRenderSnapshot): void {
    const line = state.highlightIndex !== null && hasConstraints(state.polytope) ? state.polytope.constraints[state.highlightIndex] : undefined;
    const clipped = line && clipLineToBoundingBox(line, visibleBounds(snap));
    if (!clipped) {
      this.hide();
      return;
    }
    const [start, end] = clipped;
    this.line.draw([start[0], start[1], 0, end[0], end[1], 0], snap.mode === "3d");
  }

  dispose(): void {
    this.line.dispose();
  }
}
