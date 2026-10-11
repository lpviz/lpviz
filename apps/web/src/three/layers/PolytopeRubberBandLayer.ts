import { getCurrentMouse } from "@/features/core/currentMouse";
import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { FatLine } from "../helpers/fatLine";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { rendersPlanarDrawing } from "../helpers/sceneVisibility";
import { PALETTE } from "../palette";
import { LayerBase } from "./base/LayerBase";
import { POLYTOPE_EDGE_THICKNESS } from "./PolytopeBaseLayer";

// The edge being drawn: from the last placed vertex to the pointer, while the region is a draft.
export class PolytopeRubberBandLayer extends LayerBase {
  private readonly line = new FatLine({ color: PALETTE.polytopeOutline, linewidth: POLYTOPE_EDGE_THICKNESS, renderOrder: RENDER_ORDER.polyEdges });
  readonly object3D = this.line.object3D;
  override readonly invalidationKeys = ["polytope"] as const;
  private readonly positions = new Float32Array(6);

  protected override visibleIn(state: State, snap: ViewportRenderSnapshot): boolean {
    return state.completionMode === "draft" && state.vertices.length >= 1 && getCurrentMouse() !== null && rendersPlanarDrawing(state, snap);
  }

  protected dependencies(state: State): readonly unknown[] {
    return [state.vertices, state.completionMode, getCurrentMouse()];
  }

  protected rebuild(state: State): void {
    const last = state.vertices[state.vertices.length - 1]!;
    const mouse = getCurrentMouse()!;
    this.positions.set([last[0], last[1], 0, mouse[0], mouse[1], 0]);
    // a sketch aid, drawn over everything in either view
    this.line.draw(this.positions, false);
  }

  dispose(): void {
    this.line.dispose();
  }
}
