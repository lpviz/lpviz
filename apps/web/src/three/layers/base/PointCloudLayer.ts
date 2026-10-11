import type { Points } from "three";
import { PointCloud, type PointCloudStyle } from "../../helpers/pointCloud";
import type { RenderSlot } from "../../Layer";
import { ZScaledLayer } from "./LayerBase";

// A z-scaled layer that is one point cloud: the iterate point clouds and the single-point
// markers. Subclasses implement rebuild() by calling draw(), or hide() when there is nothing.
export abstract class PointCloudLayer extends ZScaledLayer {
  readonly object3D: Points;
  override readonly slot: RenderSlot;
  private readonly cloud: PointCloud;

  constructor(style: PointCloudStyle) {
    super();
    this.cloud = new PointCloud(style);
    this.object3D = this.cloud.points;
    this.slot = style.slot;
  }

  protected draw(count: number, writePositions: (out: Float32Array) => void, writeColors?: ((out: Float32Array) => void) | null): void {
    this.cloud.draw(count, writePositions, writeColors);
  }

  dispose(): void {
    this.cloud.dispose();
  }
}
