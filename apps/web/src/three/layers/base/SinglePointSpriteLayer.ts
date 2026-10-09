import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import type { Texture } from "three";
import { iteratePosition } from "../../helpers/iteratePositions";
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
  protected abstract selectIndex(state: State): number | null;
  /** Extra inputs `selectIndex` reads, beyond iteratePath/mode. */
  protected abstract selectorDeps(state: State): readonly unknown[];

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [...this.selectorDeps(state), state.iteratePath, snap.mode];
  }

  protected rebuild(state: State): void {
    const index = this.selectIndex(state);
    const xyz = index === null ? null : iteratePosition(state.iteratePath, index);
    if (!xyz) {
      this.hide();
      return;
    }
    this.draw(1, (pos) => pos.set(xyz));
  }
}
