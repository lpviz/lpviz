import { displayedSolverStartPoint, getState } from "@/features/core/store";
import { flatPointXYZ } from "../helpers/flatPositions";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { SHARED_RING_TEXTURE } from "../helpers/sharedTextures";
import { PointCloudLayer } from "./base/PointCloudLayer";

// Subtle draggable marker for where IPM/PDHG/primal-simplex begin iterating:
// a small gray ring at the effective start point (see
// displayedSolverStartPoint for the applicability/snapping rules). In 3D it
// rides at the first iterate's render height — the per-solver convergence
// lift (mu for IPM, scaled eps for PDHG, zero for simplex) — so it stays
// attached to the start of the path at any zScale; in 2D everything flattens
// to the floor. Dragging maps through the z = 0 plane like the vertices.
// Unlike the other iterate layers it does not hide during the 2D/3D
// transition.
export class SolverStartLayer extends PointCloudLayer {
  constructor() {
    super({
      color: "#8a8a8a",
      opacity: 0.9,
      pixelSize: 15,
      texture: SHARED_RING_TEXTURE,
      renderOrder: RENDER_ORDER.solverStart,
      renderPass: "overlay",
      invalidationKeys: ["iterate"],
      vertexColors: false,
    });
  }

  protected dependencies(): readonly unknown[] {
    const raw = getState();
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
    ];
  }

  protected rebuild(): void {
    const raw = getState();
    const point = displayedSolverStartPoint(raw);
    if (!point) {
      this.hide();
      return;
    }
    const first = flatPointXYZ(raw.iteratePath, 0, raw.iterateObjectiveVector);
    this.draw(1, (pos) => pos.set([point.x, point.y, first?.[2] ?? 0]));
  }
}
