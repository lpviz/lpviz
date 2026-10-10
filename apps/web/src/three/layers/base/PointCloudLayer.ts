import type { Points } from "three";
import { PointCloud, type PointCloudStyle } from "../../helpers/pointCloud";
import type { Layer, RenderPassName } from "../../Layer";
import { ZScaledLayer } from "./LayerBase";

export type PointCloudConfig = PointCloudStyle & {
  renderPass: RenderPassName;
  invalidationKeys: Layer["invalidationKeys"];
};

// A z-scaled layer that is one point cloud: the iterate point clouds and the single-point
// markers. Subclasses implement rebuild() by calling draw(), or hide() when there is nothing.
export abstract class PointCloudLayer extends ZScaledLayer {
  readonly object3D: Points;
  override readonly renderPass: RenderPassName;
  override readonly invalidationKeys: Layer["invalidationKeys"];
  private readonly cloud: PointCloud;

  constructor(config: PointCloudConfig) {
    super();
    this.cloud = new PointCloud(config);
    this.object3D = this.cloud.points;
    this.renderPass = config.renderPass;
    this.invalidationKeys = config.invalidationKeys;
  }

  protected draw(count: number, writePositions: (out: Float32Array) => void, writeColors?: ((out: Float32Array) => void) | null): void {
    this.cloud.draw(count, writePositions, writeColors);
  }

  dispose(): void {
    this.cloud.dispose();
  }
}
