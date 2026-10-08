import { getCurrentMouse } from "@/features/core/currentMouse";
import { getState } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { rendersPlanarDrawing } from "../helpers/sceneVisibility";
import { applyHugeBounds } from "../helpers/hugeBounds";
import { lineDepthMaterial, replaceLinePositions, setupLine } from "../helpers/sharedLineMaterials";
import type { Layer, LayerPlacement } from "../Layer";
import { PALETTE } from "../palette";

const POLY_LINE_THICKNESS = 2;

const rbMat = lineDepthMaterial(PALETTE.polytopeOutline, POLY_LINE_THICKNESS, false);

const RUBBER_BAND_BUF = new Float32Array(6);

export class PolytopeRubberBandLayer implements Layer {
  readonly object3D: Line2;
  readonly invalidationKeys = ["polytope"] as const;

  constructor() {
    const geo = new LineGeometry();
    geo.setPositions([0, 0, 0, 0, 0, 0]);
    applyHugeBounds(geo);
    this.object3D = setupLine(new Line2(geo, rbMat), RENDER_ORDER.polyEdges);
  }

  placements(): readonly LayerPlacement[] {
    return [{ object3D: this.object3D, pass: "foreground" }];
  }

  update(): void {
    const state = getState();
    const verts = state.vertices;
    const last = state.completionMode === "draft" && verts.length >= 1 ? verts[verts.length - 1]! : null;
    const mouse = getCurrentMouse();
    if (!last || !rendersPlanarDrawing(getViewportRenderSnapshot().mode, state) || !mouse) {
      this.object3D.visible = false;
      return;
    }

    RUBBER_BAND_BUF[0] = last[0];
    RUBBER_BAND_BUF[1] = last[1];
    RUBBER_BAND_BUF[2] = 0;
    RUBBER_BAND_BUF[3] = mouse[0];
    RUBBER_BAND_BUF[4] = mouse[1];
    RUBBER_BAND_BUF[5] = 0;
    replaceLinePositions(this.object3D.geometry, RUBBER_BAND_BUF);
    this.object3D.visible = true;
  }

  dispose(): void {
    this.object3D.geometry.dispose();
  }
}
