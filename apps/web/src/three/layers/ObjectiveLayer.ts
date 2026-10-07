import { getState } from "@/features/core/store";
import { isUnboundedDirection } from "@/features/problem/selectors";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { lineDepthMaterial, lineGeometry, replaceLinePositions, setupLine } from "../helpers/sharedLineMaterials";
import { LayerBase } from "./base/LayerBase";

const OBJECTIVE_COLOR = "#008000";
const OBJECTIVE_UNBOUNDED_COLOR = "#ff0000";
const OBJECTIVE_RENDER_ORDER = RENDER_ORDER.objective;
const OBJECTIVE_LINE_THICKNESS = 3;
const OBJECTIVE_HEAD_LENGTH_PX = 16;
const ARROW_HALF_ANGLE = Math.PI / 6;
const OBJECTIVE_EPSILON = 1e-3;

export class ObjectiveLayer extends LayerBase {
  readonly object3D = setupLine(new LineSegments2(lineGeometry(), lineDepthMaterial(OBJECTIVE_COLOR, OBJECTIVE_LINE_THICKNESS, false)), OBJECTIVE_RENDER_ORDER);
  override readonly invalidationKeys = ["objective"] as const;

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

    if (!target || Math.hypot(target[0], target[1]) < OBJECTIVE_EPSILON) {
      this.object3D.visible = false;
      return;
    }

    const headLength = OBJECTIVE_HEAD_LENGTH_PX * snap.unitsPerPixel;
    const angle = Math.atan2(target[1], target[0]);

    // the shaft, then the two arrow-head strokes back from the tip
    const positions = [0, 0, 0, target[0], target[1], 0];
    for (const offset of [ARROW_HALF_ANGLE, -ARROW_HALF_ANGLE]) {
      const a = angle + offset;
      positions.push(target[0], target[1], 0, target[0] - headLength * Math.cos(a), target[1] - headLength * Math.sin(a), 0);
    }

    replaceLinePositions(this.object3D.geometry, positions);

    const isUnbounded = isUnboundedDirection(raw, target);

    this.object3D.material = lineDepthMaterial(isUnbounded ? OBJECTIVE_UNBOUNDED_COLOR : OBJECTIVE_COLOR, OBJECTIVE_LINE_THICKNESS, snap.mode === "3d");
    this.object3D.visible = true;
  }

  dispose(): void {
    this.object3D.geometry.dispose();
  }
}
