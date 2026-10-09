import { displayedSolverStartPoint, type State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { iteratePosition } from "../helpers/iteratePositions";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { SHARED_RING_TEXTURE } from "../helpers/sharedTextures";
import { PALETTE } from "../palette";
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
      color: PALETTE.solverStart,
      opacity: 0.9,
      pixelSize: 15,
      texture: SHARED_RING_TEXTURE,
      renderOrder: RENDER_ORDER.solverStart,
      renderPass: "overlay",
      invalidationKeys: ["iterate"],
      vertexColors: false,
    });
  }

  // shown through the 2D/3D transition too, unlike the other iterate layers
  protected override visibleIn(): boolean {
    return true;
  }

  protected dependencies(state: State, _snap: ViewportRenderSnapshot): readonly unknown[] {
    return [
      state.solverStartPoint,
      state.solverMode,
      state.solverSettings.simplexDualMode,
      state.vertices,
      state.completionMode,
      state.objectiveVector,
      state.currentObjective,
      state.polytope,
      state.iteratePath,
    ];
  }

  protected rebuild(state: State, _snap: ViewportRenderSnapshot): void {
    const point = displayedSolverStartPoint(state);
    if (!point) {
      this.hide();
      return;
    }
    const first = iteratePosition(state.iteratePath, 0);
    this.draw(1, (pos) => pos.set([point[0], point[1], first?.[2] ?? 0]));
  }
}
