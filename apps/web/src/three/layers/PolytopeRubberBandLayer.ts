import { getCurrentMouse } from "@/features/core/currentMouse";
import { getState } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { applyHugeBounds } from "../helpers/hugeBounds";
import { lineDepthMaterial, replaceLinePositions, setupLine } from "../helpers/sharedLineMaterials";
import type { Layer } from "../Layer";

const POLYTOPE_OUTLINE_COLOR = "#000000";

const POLY_LINE_THICKNESS = 2;

const rbMat = lineDepthMaterial(POLYTOPE_OUTLINE_COLOR, POLY_LINE_THICKNESS, false);

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

  update(): void {
    const state = getState();
    const verts = state.vertices;
    const last = state.completionMode === "draft" && verts.length >= 1 ? verts[verts.length - 1]! : null;
    const mouse = getCurrentMouse();
    if (!last || !shouldRenderSnapshotMode(getViewportRenderSnapshot().mode, state) || !mouse) {
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
