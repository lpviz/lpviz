import { getState, type State } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import type { Texture } from "three";
import { flatPointXYZ } from "../../helpers/flatPositions";
import { shouldRenderSnapshotMode } from "../../helpers/sceneVisibility";
import type { RenderPassName } from "../../Layer";
import { PointCloudLayer } from "./PointCloudLayer";

export type SinglePointSpriteConfig = {
  color: string;
  pixelSize: number;
  texture: Texture;
  renderOrder: number;
  renderPass: RenderPassName;
};

// One sprite at a single iterate of the path: a one-point cloud. The star
// (last iterate) and the hover highlight (selected iterate) differ only in
// texture/size/order/pass and which index they pick.
export abstract class SinglePointSpriteLayer extends PointCloudLayer {
  constructor(config: SinglePointSpriteConfig) {
    super({ ...config, invalidationKeys: ["iterate"], vertexColors: false });
  }

  /** The iterate index to show, or null to hide. */
  protected abstract selectIndex(raw: State): number | null;
  /** Extra inputs `selectIndex` reads, beyond iteratePath/objective/mode. */
  protected abstract selectorDeps(raw: State): readonly unknown[];

  protected dependencies(): readonly unknown[] {
    const raw = getState();
    return [...this.selectorDeps(raw), raw.iteratePath, raw.iterateObjectiveVector, getViewportRenderSnapshot().mode];
  }

  protected rebuild(): void {
    const raw = getState();
    const index = shouldRenderSnapshotMode(getViewportRenderSnapshot().mode, raw) ? this.selectIndex(raw) : null;
    const xyz = index === null ? null : flatPointXYZ(raw.iteratePath, index, raw.iterateObjectiveVector);
    if (!xyz) {
      this.hide();
      return;
    }
    this.draw(1, (pos) => pos.set(xyz));
  }
}
