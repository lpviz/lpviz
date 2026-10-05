import { getState } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import type { PointXY } from "@lpviz/math/types";
import { isObjectiveDirectionUnbounded } from "@lpviz/polytope/objectiveDirection";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";
import { Group } from "three";
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

const getObjectiveMat = (color: string, is3D: boolean) => lineDepthMaterial(color, OBJECTIVE_LINE_THICKNESS, is3D);

function buildArrowHeadSegments(tip: PointXY, angle: number, length: number): [number, number, number, number][] {
  return [ARROW_HALF_ANGLE, -ARROW_HALF_ANGLE].map((offset) => {
    const a = angle + offset;
    return [tip.x, tip.y, tip.x - length * Math.cos(a), tip.y - length * Math.sin(a)] as [number, number, number, number];
  });
}

export class ObjectiveLayer extends LayerBase {
  readonly object3D: Group;
  override readonly invalidationKeys = ["objective"] as const;
  private objGeo: LineSegmentsGeometry;
  private objSegs: LineSegments2;

  constructor() {
    super();
    const objGeo = new LineSegmentsGeometry();
    applyHugeBounds(objGeo);
    const objSegs = new LineSegments2(objGeo, getObjectiveMat(OBJECTIVE_COLOR, false));
    objSegs.renderOrder = OBJECTIVE_RENDER_ORDER;
    objSegs.frustumCulled = false;
    objSegs.visible = false;
    const group = new Group();
    group.add(objSegs);
    this.object3D = group;
    this.objGeo = objGeo;
    this.objSegs = objSegs;
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
      this.objSegs.visible = false;
      return;
    }

    const target = raw.objectiveVector || (raw.completionMode !== "draft" && raw.currentObjective ? raw.currentObjective : null);

    if (!target || Math.hypot(target.x, target.y) < OBJECTIVE_EPSILON) {
      this.objSegs.visible = false;
      return;
    }

    const headLength = OBJECTIVE_HEAD_LENGTH_PX * snap.unitsPerPixel;
    const angle = Math.atan2(target.y, target.x);

    const positions: number[] = [0, 0, 0, target.x, target.y, 0];
    for (const [x1, y1, x2, y2] of buildArrowHeadSegments(target, angle, headLength)) {
      positions.push(x1, y1, 0, x2, y2, 0);
    }

    replaceLinePositions(this.objGeo, positions);

    const isUnbounded = raw.polytope?.kind === "unbounded" && hasPolytopeLines(raw.polytope) && isObjectiveDirectionUnbounded(raw.polytope.lines, [target.x, target.y]);

    this.objSegs.material = getObjectiveMat(isUnbounded ? OBJECTIVE_UNBOUNDED_COLOR : OBJECTIVE_COLOR, snap.mode === "3d");
    this.objSegs.visible = true;
  }

  dispose(): void {
    this.objGeo.dispose();
  }
}
