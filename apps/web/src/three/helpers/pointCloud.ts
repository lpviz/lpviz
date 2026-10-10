import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Points, PointsMaterial, type Texture } from "three";
import { applyHugeBounds } from "./hugeBounds";

export type PointCloudStyle = {
  color: string;
  opacity?: number;
  pixelSize: number;
  texture: Texture;
  renderOrder: number;
  // true to support an optional per-point color attribute (phase coloring)
  vertexColors: boolean;
};

// Every point sprite in the app: a fixed screen-size, depth-ignoring sprite
// whose shape is an alpha map (see sharedTextures.ts).
const spriteMaterial = (style: PointCloudStyle, color: string, vertexColors: boolean) =>
  new PointsMaterial({
    color,
    size: style.pixelSize,
    sizeAttenuation: false,
    transparent: (style.opacity ?? 1) < 1,
    opacity: style.opacity ?? 1,
    depthTest: false,
    depthWrite: false,
    alphaMap: style.texture,
    alphaTest: 0.2,
    vertexColors,
  });

// A point sprite cloud drawn in place: one grow-only DynamicDrawUsage position attribute (and
// optional color attribute) and the plain/colored material pair. draw() writes straight into
// the attribute arrays, so no intermediate copy exists on the rotation hot path. The geometry
// starts empty with fake huge bounds, so the renderer neither computes them nor culls it.
export class PointCloud {
  readonly points: Points;
  private readonly plain: PointsMaterial;
  private readonly colored: PointsMaterial | null;

  constructor(style: PointCloudStyle) {
    this.plain = spriteMaterial(style, style.color, false);
    this.colored = style.vertexColors ? spriteMaterial(style, "#ffffff", true) : null;
    const geometry = new BufferGeometry();
    applyHugeBounds(geometry);
    this.points = new Points(geometry, this.plain);
    this.points.renderOrder = style.renderOrder;
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  draw(count: number, writePositions: (out: Float32Array) => void, writeColors?: ((out: Float32Array) => void) | null): void {
    if (count === 0) {
      this.points.visible = false;
      return;
    }
    const geometry = this.points.geometry;
    writePositions(growAttribute(geometry.getAttribute("position") as BufferAttribute | undefined, count, (attribute) => geometry.setAttribute("position", attribute)));
    if (writeColors && this.colored) {
      writeColors(growAttribute(geometry.getAttribute("color") as BufferAttribute | undefined, count, (attribute) => geometry.setAttribute("color", attribute)));
      this.points.material = this.colored;
    } else {
      this.points.material = this.plain;
    }
    geometry.setDrawRange(0, count);
    this.points.visible = true;
  }

  dispose(): void {
    this.plain.dispose();
    this.colored?.dispose();
    this.points.geometry.dispose();
  }
}

// The attribute's array, with the attribute replaced by a larger one when it holds fewer than
// `count` points, flagged for upload either way.
function growAttribute(attribute: BufferAttribute | undefined, count: number, install: (attribute: BufferAttribute) => void): Float32Array {
  let grown = attribute;
  if (!grown || grown.count < count) {
    grown = new BufferAttribute(new Float32Array(count * 3), 3);
    grown.setUsage(DynamicDrawUsage);
    install(grown);
  }
  grown.needsUpdate = true;
  return grown.array as Float32Array;
}
