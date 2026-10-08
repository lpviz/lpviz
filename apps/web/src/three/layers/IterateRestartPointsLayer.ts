import { iterateHeight, type State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { writePhaseColors } from "../helpers/phaseColors";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { SHARED_SQUARE_TEXTURE } from "../helpers/sharedTextures";
import { PALETTE } from "../palette";
import { PointCloudLayer } from "./base/PointCloudLayer";

// Square markers on the iterates where PDHG restarted (a subset of the path).
export class IterateRestartPointsLayer extends PointCloudLayer {
  constructor() {
    super({
      color: PALETTE.iterate,
      pixelSize: 8 * 1.4,
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

  protected rebuild(state: State, snap: ViewportRenderSnapshot): void {
    const path = state.iteratePath;
    const { points, count, stride } = path;
    if (!shouldRenderSnapshotMode(snap.mode, state)) {
      this.hide();
      return;
    }
    const indices = state.iterateRestartIndices.filter((idx) => idx >= 0 && idx < count);
    if (indices.length === 0) {
      this.hide();
      return;
    }
    const phases = state.iteratePhases;
    const hasPhases = phases.length === count && phases.length > 0;
    this.draw(
      indices.length,
      (pos) => {
        for (let i = 0; i < indices.length; i++) {
          const index = indices[i]!;
          const base = index * stride;
          pos[i * 3] = points[base]!;
          pos[i * 3 + 1] = points[base + 1]!;
          pos[i * 3 + 2] = iterateHeight(path, index);
        }
      },
      hasPhases ? (col) => writePhaseColors(col, phases, indices, indices.length) : null,
    );
  }
}
