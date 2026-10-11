import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { writeIteratePositions } from "../helpers/iteratePositions";
import { phasesCovering, writePhaseColors } from "../helpers/phaseColors";
import { PALETTE, SPRITE } from "../palette";
import { PointCloudLayer } from "./base/PointCloudLayer";

// Square markers on the iterates where PDHG restarted (a subset of the path).
export class IterateRestartPointsLayer extends PointCloudLayer {
  override readonly invalidationKeys = ["iterate"] as const;

  constructor() {
    super({ color: PALETTE.iterate, pixelSize: SPRITE.iterate * 1.4, shape: "square", slot: "iterateRestartPoints", vertexColors: true });
  }

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.iteratePath, state.iteratePhases, state.iterateRestartIndices, snap.mode];
  }

  protected rebuild(state: State): void {
    const path = state.iteratePath;
    const indices = state.iterateRestartIndices.filter((idx) => idx >= 0 && idx < path.count);
    if (indices.length === 0) {
      this.hide();
      return;
    }
    const phases = phasesCovering(state.iteratePhases, path.count);
    this.draw(indices.length, (pos) => writeIteratePositions(pos, path, indices.length, indices), phases ? (col) => writePhaseColors(col, phases, indices, indices.length) : null);
  }
}
