import { computeFlatZ } from "@/features/core/store";
import { PHASE_COLORS_LINEAR } from "../helpers/phaseColors";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { SHARED_SQUARE_TEXTURE } from "../helpers/sharedTextures";
import type { SceneContext } from "../SceneContext";
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

  protected dependencies(ctx: SceneContext): readonly unknown[] {
    const raw = ctx.getState();
    return [raw.iteratePath, raw.iteratePhases, raw.iterateRestartIndices, raw.iterateObjectiveVector, ctx.getSnapshot().mode];
  }

  protected rebuild(ctx: SceneContext): void {
    const raw = ctx.getState();
    const { points, count, stride } = raw.iteratePath;
    if (!shouldRenderSnapshotMode(ctx.getSnapshot().mode, raw)) {
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
    const objVec = raw.iterateObjectiveVector;
    this.draw(
      indices.length,
      (pos) => {
        for (let i = 0; i < indices.length; i++) {
          const base = indices[i]! * stride;
          pos[i * 3] = points[base]!;
          pos[i * 3 + 1] = points[base + 1]!;
          pos[i * 3 + 2] = computeFlatZ(points, base, stride, objVec);
        }
      },
      hasPhases
        ? (col) => {
            for (let i = 0; i < indices.length; i++) {
              const rgb = PHASE_COLORS_LINEAR[phases[indices[i]!]! % PHASE_COLORS_LINEAR.length]!;
              col[i * 3] = rgb[0];
              col[i * 3 + 1] = rgb[1];
              col[i * 3 + 2] = rgb[2];
            }
          }
        : null,
    );
  }
}
