import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { writeIteratePositions } from "../helpers/iteratePositions";
import { writePhaseColors } from "../helpers/phaseColors";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { SHARED_CIRCLE_TEXTURE } from "../helpers/sharedTextures";
import { PALETTE } from "../palette";
import { PointCloudLayer } from "./base/PointCloudLayer";

// The solved iterate path as a point cloud, optionally colored by solver phase.
export class IteratePointsLayer extends PointCloudLayer {
  constructor() {
    super({
      color: PALETTE.iterate,
      pixelSize: 8,
      texture: SHARED_CIRCLE_TEXTURE,
      renderOrder: RENDER_ORDER.iteratePoints,
      renderPass: "trace",
      invalidationKeys: ["iterate"],
      vertexColors: true,
    });
  }

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.iteratePath, state.iteratePhases, state.replayActive, snap.mode];
  }

  protected rebuild(state: State): void {
    const path = state.iteratePath;
    // A replay's last point is the interpolated head sliding along the current
    // segment, not an iterate. The line layer draws it (that is the sweep), but
    // a dot there would be indistinguishable from a real iterate, so the cloud
    // stops one short and each dot appears exactly as the head reaches it.
    const count = path.count - (state.replayActive ? 1 : 0);
    if (count <= 0) {
      this.hide();
      return;
    }
    const phases = state.iteratePhases;
    const hasPhases = phases.length >= count && phases.length > 0;
    this.draw(count, (pos) => writeIteratePositions(pos, path, count), hasPhases ? (col) => writePhaseColors(col, phases, null, count) : null);
  }
}
