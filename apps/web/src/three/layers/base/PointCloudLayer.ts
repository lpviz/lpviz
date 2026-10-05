import type { ViewportDirtyFlags } from "@/features/core/store";
import { BufferAttribute, DynamicDrawUsage, Points, PointsMaterial, type Texture } from "three";
import { makePointsGeo } from "../../helpers/makePointsGeo";
import type { RenderPassName } from "../../Layer";
import type { SceneContext } from "../../SceneContext";
import { LayerBase } from "./LayerBase";

export type PointCloudConfig = {
  color: string;
  pixelSize: number;
  texture: Texture;
  renderOrder: number;
  renderPass: RenderPassName;
  invalidationKeys: readonly (keyof ViewportDirtyFlags)[];
  // true to support an optional per-point color attribute (phase coloring)
  vertexColors: boolean;
};

// Shared base for the iterate point clouds. Owns one correct grow-only
// DynamicDrawUsage position attribute (and optional color attribute), the
// plain/colored material pair, and the scale.z transform — all of which used to
// be hand-rolled, and inconsistently (some layers allocated fresh buffers every
// frame). Subclasses implement rebuild() by calling draw(count, writePositions,
// writeColors?), writing directly into the grow-only arrays (no intermediate
// copy on the rotation hot path).
export abstract class PointCloudLayer extends LayerBase {
  readonly object3D: Points;
  override readonly renderPass: RenderPassName;
  override readonly invalidationKeys: readonly (keyof ViewportDirtyFlags)[];
  private matPlain: PointsMaterial;
  private matColored: PointsMaterial | null;

  constructor(config: PointCloudConfig) {
    super();
    const shared = {
      size: config.pixelSize,
      sizeAttenuation: false,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      alphaMap: config.texture,
      alphaTest: 0.2,
    };
    this.matPlain = new PointsMaterial({ ...shared, color: config.color });
    this.matColored = config.vertexColors ? new PointsMaterial({ ...shared, color: "#ffffff", vertexColors: true }) : null;
    const points = new Points(makePointsGeo(), this.matPlain);
    points.renderOrder = config.renderOrder;
    points.frustumCulled = false;
    points.visible = false;
    this.object3D = points;
    this.renderPass = config.renderPass;
    this.invalidationKeys = config.invalidationKeys;
  }

  protected override everyFrame(ctx: SceneContext): void {
    this.applyZScale(ctx);
  }

  protected hide(): void {
    this.object3D.visible = false;
  }

  // Grow-only point render: positions (and optional colors) are written in place
  // into reused DynamicDrawUsage attributes.
  protected draw(count: number, writePositions: (out: Float32Array) => void, writeColors?: ((out: Float32Array) => void) | null): void {
    if (count === 0) {
      this.object3D.visible = false;
      return;
    }
    const geometry = this.object3D.geometry;
    let pos = geometry.getAttribute("position") as BufferAttribute | undefined;
    if (!pos || pos.count < count) {
      pos = new BufferAttribute(new Float32Array(count * 3), 3);
      pos.setUsage(DynamicDrawUsage);
      geometry.setAttribute("position", pos);
    }
    writePositions(pos.array as Float32Array);
    pos.needsUpdate = true;

    if (writeColors && this.matColored) {
      let col = geometry.getAttribute("color") as BufferAttribute | undefined;
      if (!col || col.count < count) {
        col = new BufferAttribute(new Float32Array(count * 3), 3);
        col.setUsage(DynamicDrawUsage);
        geometry.setAttribute("color", col);
      }
      writeColors(col.array as Float32Array);
      col.needsUpdate = true;
      this.object3D.material = this.matColored;
    } else {
      this.object3D.material = this.matPlain;
    }
    geometry.setDrawRange(0, count);
    this.object3D.visible = true;
  }

  dispose(): void {
    this.matPlain.dispose();
    this.matColored?.dispose();
    this.object3D.geometry.dispose();
  }
}
