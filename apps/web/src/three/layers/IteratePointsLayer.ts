import { getState } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { writeIteratePositions } from "../helpers/iteratePositions";
import { writePhaseColors } from "../helpers/phaseColors";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { SHARED_CIRCLE_TEXTURE } from "../helpers/sharedTextures";
import { PointCloudLayer } from "./base/PointCloudLayer";

// The solved iterate path as a point cloud, optionally colored by solver phase.
export class IteratePointsLayer extends PointCloudLayer {
  constructor() {
    super({
      color: "#800080",
      pixelSize: 8,
      texture: SHARED_CIRCLE_TEXTURE,
      renderOrder: RENDER_ORDER.iteratePoints,
      renderPass: "trace",
      invalidationKeys: ["iterate"],
      vertexColors: true,
    });
  }

  protected dependencies(): readonly unknown[] {
    const raw = getState();
    return [raw.iteratePath, raw.iteratePhases, raw.replayActive, getViewportRenderSnapshot().mode];
  }

  protected rebuild(): void {
    const raw = getState();
    const path = raw.iteratePath;
    // A replay's last point is the interpolated head sliding along the current
    // segment, not an iterate. The line layer draws it (that is the sweep), but
    // a dot there would be indistinguishable from a real iterate, so the cloud
    // stops one short and each dot appears exactly as the head reaches it.
    const count = path.count - (raw.replayActive ? 1 : 0);
    if (count <= 0 || !shouldRenderSnapshotMode(getViewportRenderSnapshot().mode, raw)) {
      this.hide();
      return;
    }
    const phases = raw.iteratePhases;
    const hasPhases = phases.length >= count && phases.length > 0;
    this.draw(count, (pos) => writeIteratePositions(pos, path, count), hasPhases ? (col) => writePhaseColors(col, phases, null, count) : null);
  }
}
