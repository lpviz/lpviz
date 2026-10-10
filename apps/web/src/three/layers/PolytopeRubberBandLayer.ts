import { getCurrentMouse } from "@/features/core/currentMouse";
import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { rendersPlanarDrawing } from "../helpers/sceneVisibility";
import { lineDepthMaterial, lineGeometry, replaceLinePositions, setupLine } from "../helpers/sharedLineMaterials";
import { PALETTE } from "../palette";
import { LayerBase } from "./base/LayerBase";
import { POLYTOPE_EDGE_THICKNESS } from "./PolytopeBaseLayer";

// The edge being drawn: from the last placed vertex to the pointer, while the region is a draft.
export class PolytopeRubberBandLayer extends LayerBase {
  readonly object3D = setupLine(new LineSegments2(lineGeometry(), lineDepthMaterial(PALETTE.polytopeOutline, POLYTOPE_EDGE_THICKNESS, false)), RENDER_ORDER.polyEdges);
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
    replaceLinePositions(this.object3D.geometry, this.positions);
    this.object3D.visible = true;
  }

  dispose(): void {
    this.object3D.geometry.dispose();
  }
}
