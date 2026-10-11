import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Points, PointsMaterial } from "three";
import { renderOrderOf, type RenderSlot } from "../Layer";
import { cacheEncodeGlsl, sharedCacheEncode } from "./cacheEncode";
import { applyHugeBounds } from "./hugeBounds";

export type SpriteShape = "disc" | "ring" | "square" | "star";

export type PointCloudStyle = {
  color: string;
  opacity?: number;
  pixelSize: number;
  shape: SpriteShape;
  slot: RenderSlot;
  // true to support an optional per-point color attribute (phase coloring)
  vertexColors: boolean;
};

// Each shape as the signed distance to its edge in sprite coordinates (the sprite spans
// -0.5..0.5 on both axes, y up), filling 0.88 of the sprite as the former alpha maps did.
const SHAPE_DISTANCE: Record<SpriteShape, string> = {
  disc: "length(p) - 0.44",
  ring: "abs(length(p) - 0.34) - 0.055",
  square: "max(abs(p.x), abs(p.y)) - 0.44",
  // five points, outer radius 0.38, inner radius 0.47 of it
  star: "starDistance(p, 0.38, 0.47)",
};

// Inigo Quilez's exact distance to a regular five-pointed star with its tip up.
const STAR_DISTANCE = /* glsl */ `
float starDistance(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
`;

// Every point sprite in the app: a fixed screen-size, depth-ignoring sprite whose shape is a
// signed distance evaluated per fragment, with a one-device-pixel antialiased edge. Exact at any
// size and pixel ratio and with no texture to filter, so the edge is as sharp as the pixel grid
// allows; it rides on PointsMaterial's own size, color and vertex-color handling. The output is
// encoded by hand while the trace bakes (see cacheEncode.ts), so a sprite in a trace chunk is the
// same pixels cached as drawn.
function spriteMaterial(style: PointCloudStyle, color: string, vertexColors: boolean): PointsMaterial {
  const material = new PointsMaterial({
    color,
    size: style.pixelSize,
    sizeAttenuation: false,
    transparent: true,
    opacity: style.opacity ?? 1,
    depthTest: false,
    depthWrite: false,
    vertexColors,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.cacheEncode = sharedCacheEncode;
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `uniform float cacheEncode;\n${STAR_DISTANCE}\nvoid main() {`)
      .replace(
        "#include <map_particle_fragment>",
        /* glsl */ `
  vec2 p = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y);
  float d = ${SHAPE_DISTANCE[style.shape]};
  diffuseColor.a *= clamp(0.5 - d / max(fwidth(d), 1e-5), 0.0, 1.0);
`,
      )
      .replace("#include <colorspace_fragment>", `gl_FragColor = ${cacheEncodeGlsl("gl_FragColor")};`);
  };
  // one program per shape, not one per material
  material.customProgramCacheKey = () => style.shape;
  return material;
}

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
    this.points.renderOrder = renderOrderOf[style.slot];
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
