import { getState } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { isObjectiveDirectionUnbounded } from "@lpviz/polytope/objectiveDirection";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { applyHugeBounds, lineDepthMaterial, replaceLinePositions } from "../helpers/sharedLineMaterials";
import { LayerBase } from "./base/LayerBase";

const OBJECTIVE_COLOR = "#008000";
const OBJECTIVE_UNBOUNDED_COLOR = "#ff0000";
const OBJECTIVE_RENDER_ORDER = RENDER_ORDER.objective;
const OBJECTIVE_LINE_THICKNESS = 3;
const OBJECTIVE_HEAD_LENGTH_PX = 16;
const ARROW_HALF_ANGLE = Math.PI / 6;
const OBJECTIVE_EPSILON = 1e-3;

export class ObjectiveLayer extends LayerBase {
  readonly object3D: LineSegments2;
  override readonly invalidationKeys = ["objective"] as const;
  private objGeo: LineSegmentsGeometry;

  constructor() {
    super();
    const objGeo = new LineSegmentsGeometry();
    applyHugeBounds(objGeo);
    const objSegs = new LineSegments2(objGeo, lineDepthMaterial(OBJECTIVE_COLOR, OBJECTIVE_LINE_THICKNESS, false));
    objSegs.renderOrder = OBJECTIVE_RENDER_ORDER;
    objSegs.frustumCulled = false;
    objSegs.visible = false;
    this.object3D = objSegs;
    this.objGeo = objGeo;
  }

  protected dependencies(): readonly unknown[] {
    const raw = getState();
    const snap = getViewportRenderSnapshot();
    return [raw.objectiveHidden, raw.objectiveVector, raw.currentObjective, raw.completionMode, raw.polytope, raw.isTransitioning3D, snap.mode, snap.unitsPerPixel];
  }

  protected rebuild(): void {
    const raw = getState();
    const snap = getViewportRenderSnapshot();

    if (raw.objectiveHidden || !shouldRenderSnapshotMode(snap.mode, raw)) {
      this.object3D.visible = false;
      return;
    }

    const target = raw.objectiveVector || (raw.completionMode !== "draft" && raw.currentObjective ? raw.currentObjective : null);

    if (!target || Math.hypot(target.x, target.y) < OBJECTIVE_EPSILON) {
      this.object3D.visible = false;
      return;
    }

    const headLength = OBJECTIVE_HEAD_LENGTH_PX * snap.unitsPerPixel;
    const angle = Math.atan2(target.y, target.x);

    // the shaft, then the two arrow-head strokes back from the tip
    const positions = [0, 0, 0, target.x, target.y, 0];
    for (const offset of [ARROW_HALF_ANGLE, -ARROW_HALF_ANGLE]) {
      const a = angle + offset;
      positions.push(target.x, target.y, 0, target.x - headLength * Math.cos(a), target.y - headLength * Math.sin(a), 0);
    }

    replaceLinePositions(this.objGeo, positions);

    const isUnbounded = raw.polytope?.kind === "unbounded" && hasPolytopeLines(raw.polytope) && isObjectiveDirectionUnbounded(raw.polytope.lines, [target.x, target.y]);

    this.object3D.material = lineDepthMaterial(isUnbounded ? OBJECTIVE_UNBOUNDED_COLOR : OBJECTIVE_COLOR, OBJECTIVE_LINE_THICKNESS, snap.mode === "3d");
    this.object3D.visible = true;
  }

  dispose(): void {
    this.objGeo.dispose();
  }
}
