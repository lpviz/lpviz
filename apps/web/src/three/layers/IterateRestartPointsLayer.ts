import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { writeIteratePositions } from "../helpers/iteratePositions";
import { writePhaseColors } from "../helpers/phaseColors";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { SHARED_SQUARE_TEXTURE } from "../helpers/sharedTextures";
import { PALETTE } from "../palette";
import { ITERATE_POINT_PIXEL_SIZE } from "./IteratePointsLayer";
import { PointCloudLayer } from "./base/PointCloudLayer";

// Square markers on the iterates where PDHG restarted (a subset of the path).
export class IterateRestartPointsLayer extends PointCloudLayer {
  constructor() {
    super({
      color: PALETTE.iterate,
      pixelSize: ITERATE_POINT_PIXEL_SIZE * 1.4,
      texture: SHARED_SQUARE_TEXTURE,
      renderOrder: RENDER_ORDER.iterateRestartPoints,
      renderPass: "trace",
      invalidationKeys: ["iterate"],
      vertexColors: true,
    });
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
    const phases = state.iteratePhases;
    const hasPhases = phases.length === path.count && phases.length > 0;
    this.draw(indices.length, (pos) => writeIteratePositions(pos, path, indices.length, indices), hasPhases ? (col) => writePhaseColors(col, phases, indices, indices.length) : null);
  }
}
