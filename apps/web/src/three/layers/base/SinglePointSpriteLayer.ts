import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { BufferAttribute, Points, PointsMaterial, type Texture } from "three";
import { flatPointXYZ } from "../../helpers/flatPositions";
import { makePointsGeo } from "../../helpers/makePointsGeo";
import { shouldRenderSnapshotMode } from "../../helpers/sceneVisibility";
import type { RenderPassName } from "../../Layer";
import type { SceneContext } from "../../SceneContext";
import { LayerBase } from "./LayerBase";

export type SinglePointSpriteConfig = {
  color: string;
  pixelSize: number;
  texture: Texture;
  renderOrder: number;
  renderPass: RenderPassName;
};

// One sprite at a single iterate of the path. The star (last iterate) and the
// hover highlight (selected iterate) differ only in texture/size/order/pass and
// which index they pick — everything else (material, z-via-scale, the
// dispose-and-replace 3-float geometry) lives here.
export abstract class SinglePointSpriteLayer extends LayerBase {
  readonly object3D: Points;
  override readonly renderPass: RenderPassName;
  override readonly invalidationKeys = ["iterate"] as const;
  private material: PointsMaterial;

  constructor(config: SinglePointSpriteConfig) {
    super();
    this.material = new PointsMaterial({
      color: config.color,
      size: config.pixelSize,
      sizeAttenuation: false,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      alphaMap: config.texture,
      alphaTest: 0.2,
    });
    const points = new Points(makePointsGeo(), this.material);
    points.renderOrder = config.renderOrder;
    points.frustumCulled = false;
    points.visible = false;
    this.object3D = points;
    this.renderPass = config.renderPass;
  }

  /** The iterate index to show, or null to hide. */
  protected abstract selectIndex(raw: State): number | null;
  /** Extra inputs `selectIndex` reads, beyond iteratePath/objective/mode. */
  protected abstract selectorDeps(raw: State): readonly unknown[];

  protected override everyFrame(ctx: SceneContext): void {
    this.applyZScale(ctx);
  }

  protected dependencies(ctx: SceneContext): readonly unknown[] {
    const raw = ctx.getState();
    return [...this.selectorDeps(raw), raw.iteratePath, raw.iterateObjectiveVector, ctx.getSnapshot().mode];
  }

  protected rebuild(ctx: SceneContext): void {
    const raw = ctx.getState();
    const snap: ViewportRenderSnapshot = ctx.getSnapshot();
    const index = shouldRenderSnapshotMode(snap.mode, raw) ? this.selectIndex(raw) : null;
    const xyz = index === null ? null : flatPointXYZ(raw.iteratePath, index, raw.iterateObjectiveVector);
    if (!xyz) {
      this.object3D.visible = false;
      return;
    }
    // free the old GL buffer before the attribute is replaced
    this.object3D.geometry.dispose();
    this.object3D.geometry.setAttribute("position", new BufferAttribute(new Float32Array(xyz), 3));
    this.object3D.visible = true;
  }

  dispose(): void {
    this.material.dispose();
    this.object3D.geometry.dispose();
  }
}
