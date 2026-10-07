import { getState, iterateHeight } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { writePhaseColors } from "../helpers/phaseColors";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { SHARED_SQUARE_TEXTURE } from "../helpers/sharedTextures";
import { PointCloudLayer } from "./base/PointCloudLayer";

// Square markers on the iterates where PDHG restarted (a subset of the path).
export class IterateRestartPointsLayer extends PointCloudLayer {
  constructor() {
    super({
      color: "#800080",
      pixelSize: 8 * 1.4,
      texture: SHARED_SQUARE_TEXTURE,
      renderOrder: RENDER_ORDER.iterateRestartPoints,
      renderPass: "trace",
      invalidationKeys: ["iterate"],
      vertexColors: true,
    });
  }

  protected dependencies(): readonly unknown[] {
    const raw = getState();
    return [raw.iteratePath, raw.iteratePhases, raw.iterateRestartIndices, getViewportRenderSnapshot().mode];
  }

  protected rebuild(): void {
    const raw = getState();
    const path = raw.iteratePath;
    const { points, count, stride } = path;
    if (!shouldRenderSnapshotMode(getViewportRenderSnapshot().mode, raw)) {
      this.hide();
      return;
    }
    const indices = raw.iterateRestartIndices.filter((idx) => idx >= 0 && idx < count);
    if (indices.length === 0) {
      this.hide();
      return;
    }
    const phases = raw.iteratePhases;
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
