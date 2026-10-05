import { getCurrentMouse } from "@/features/core/currentMouse";
import { getState } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { applyHugeBounds, lineDepthMaterial, replaceLinePositions } from "../helpers/sharedLineMaterials";
import type { Layer } from "../Layer";

const POLYTOPE_OUTLINE_COLOR = "#000000";

const POLY_LINE_THICKNESS = 2;

const rbMat = lineDepthMaterial(POLYTOPE_OUTLINE_COLOR, POLY_LINE_THICKNESS, false);

const RUBBER_BAND_BUF = new Float32Array(6);

export class PolytopeRubberBandLayer implements Layer {
  readonly object3D: Line2;
  readonly invalidationKeys = ["polytope"] as const;
  private geometry: LineGeometry;

  constructor() {
    const geo = new LineGeometry();
    geo.setPositions([0, 0, 0, 0, 0, 0]);
    applyHugeBounds(geo);
    const ln = new Line2(geo, rbMat);
    ln.frustumCulled = false;
    ln.renderOrder = RENDER_ORDER.polyEdges;
    ln.visible = false;
    this.object3D = ln;
    this.geometry = geo;
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

    RUBBER_BAND_BUF[0] = last.x;
    RUBBER_BAND_BUF[1] = last.y;
    RUBBER_BAND_BUF[2] = 0;
    RUBBER_BAND_BUF[3] = mouse.x;
    RUBBER_BAND_BUF[4] = mouse.y;
    RUBBER_BAND_BUF[5] = 0;
    replaceLinePositions(this.geometry, RUBBER_BAND_BUF);
    this.object3D.visible = true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
