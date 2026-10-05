import type { State } from "@/features/core/store";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { applyHugeBounds, getSharedLineMaterial, replaceLinePositions } from "../helpers/sharedLineMaterials";
import type { Layer } from "../Layer";
import type { SceneContext } from "../SceneContext";

const POLYTOPE_OUTLINE_COLOR = "#000000";

const POLY_LINE_THICKNESS = 2;

const rbMat = getSharedLineMaterial({
  color: POLYTOPE_OUTLINE_COLOR,
  linewidth: POLY_LINE_THICKNESS,
  depthTest: false,
  depthWrite: false,
  opacity: 1,
});

type RubberBandState = {
  lastVertex: import("@lpviz/math/types").PointXY | null;
  is3DMode: boolean;
  isTransitioning3D: boolean;
};

function selectRubberBandState(state: State): RubberBandState {
  const isDraft = state.completionMode === "draft";
  const verts = state.vertices;
  const active = isDraft && verts.length >= 1;
  return {
    lastVertex: active ? verts[verts.length - 1]! : null,
    is3DMode: state.is3DMode,
    isTransitioning3D: state.isTransitioning3D,
  };
}

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
    ln.computeLineDistances = () => ln;
    ln.visible = false;
    this.object3D = ln;
    this.geometry = geo;
  }

  update(ctx: SceneContext): void {
    const state = ctx.getState();
    const snap = ctx.getSnapshot();
    const rbState = selectRubberBandState(state);

    if (!rbState.lastVertex || !shouldRenderSnapshotMode(snap.mode, rbState)) {
      this.object3D.visible = false;
      return;
    }
    const mouse = ctx.getCurrentMouse();
    if (!mouse) {
      this.object3D.visible = false;
      return;
    }

    const last = rbState.lastVertex;
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
