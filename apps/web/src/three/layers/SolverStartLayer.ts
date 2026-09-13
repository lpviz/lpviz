import { displayedSolverStartPoint } from "@/features/core/store";
import { BufferAttribute, Points, PointsMaterial } from "three";
import { flatPointXYZ } from "../helpers/flatPositions";
import { makePointsGeo } from "../helpers/makePointsGeo";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { SHARED_RING_TEXTURE } from "../helpers/sharedTextures";
import type { SceneContext } from "../SceneContext";
import { LayerBase } from "./base/LayerBase";

// Subtle draggable marker for where IPM/PDHG/primal-simplex begin iterating:
// a small gray ring at the effective start point (see
// displayedSolverStartPoint for the applicability/snapping rules). In the
// lifted 3D view of a 2-variable problem it rides at the first iterate's
// render height — the per-solver convergence lift (mu for IPM, scaled eps for
// PDHG, zero for simplex) — so it stays attached to the start of the path at
// any zScale; in 2D everything flattens to the floor. Dragging maps through the
// z = 0 plane like the vertices. In the 3-variable editor the marker is a
// point in space with its own z, dragged on the camera-facing plane.
export class SolverStartLayer extends LayerBase {
  readonly object3D: Points;
  override readonly renderPass = "overlay" as const;
  override readonly invalidationKeys = ["iterate"] as const;
  private material: PointsMaterial;

  constructor() {
    super();
    this.material = new PointsMaterial({
      color: "#8a8a8a",
      size: 15,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      alphaMap: SHARED_RING_TEXTURE,
      alphaTest: 0.2,
    });
    const points = new Points(makePointsGeo(), this.material);
    points.renderOrder = RENDER_ORDER.solverStart;
    points.frustumCulled = false;
    points.visible = false;
    this.object3D = points;
  }

  protected override everyFrame(ctx: SceneContext): void {
    this.applyZScale(ctx);
  }

  protected dependencies(ctx: SceneContext): readonly unknown[] {
    const raw = ctx.getState();
    return [
      raw.solverStartPoint,
      raw.solverMode,
      raw.solverSettings.simplexDualMode,
      raw.vertices,
      raw.completionMode,
      raw.objectiveVector,
      raw.currentObjective,
      raw.polytope,
      raw.iteratePath,
      raw.iterateObjectiveVector,
      raw.problemMode,
      raw.editor3Phase,
      raw.polytope3,
      raw.objectiveVector3,
    ];
  }

  protected rebuild(ctx: SceneContext): void {
    const raw = ctx.getState();
    const point = displayedSolverStartPoint(raw);
    if (!point) {
      this.object3D.visible = false;
      return;
    }
    const first = flatPointXYZ(raw.iteratePath, 0, raw.iterateObjectiveVector);
    const z = point.z ?? first?.[2] ?? 0;
    this.object3D.geometry.dispose();
    this.object3D.geometry.setAttribute(
      "position",
      new BufferAttribute(Float32Array.of(point.x, point.y, z), 3),
    );
    this.object3D.visible = true;
  }

  dispose(): void {
    this.material.dispose();
    this.object3D.geometry.dispose();
  }
}
