import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  GLSL3,
  Mesh,
  ShaderMaterial,
  Vector2,
} from "three";
import {
  DUMMY_COLOR_TEXTURE,
  PATH_TEXEL_GLSL,
  PathTextures,
} from "./pathTextures";
import { applyHugeBounds } from "./sharedLineMaterials";

// Constant screen-width polyline rendering with true fat-line styling at a
// fraction of the cost of instanced fat lines (Line2): one uncapped quad per
// segment, extruded in the vertex shader along that segment's own screen-space
// normal. Line2 expands every segment into a *capped* quad — at millions of
// sub-pixel segments that is orders of magnitude of redundant overdraw —
// whereas uncapped quads tile the path edge to edge and rasterize
// width x on-screen-length once, the same as a continuous ribbon.
//
// Extruding per segment (rather than sharing two mitered vertices per point,
// as this did originally) is what makes the width *actually* constant: a
// shared-vertex joint has to reach the intersection of the two offset edges to
// keep both segments full width, which grows without bound as a turn
// approaches a hairpin. Clamping that miter is what made zig-zagging paths —
// the ellipsoid method's especially, where a third of the joints turn by more
// than 120° — visibly taper toward every corner. The cost is a small wedge of
// missing ink on the outside of sharp corners, which at these widths reads as
// a mitre-less join rather than as a defect.
//
// The path lives in a float texture indexed by gl_VertexID (four vertices per
// segment, no vertex attributes at all; see pathTextures.ts), so a path costs
// one RGBA32F texel per point of GPU memory and geometries share a single
// static index buffer. In 3D the iterate path renders as a tube instead (see
// pathTube.ts), built on the same textures.

// Shared by reference across every ribbon material; updated on resize via
// tickSharedLineMaterialResolutions (CSS pixels, matching LineMaterial).
const sharedResolution = new Vector2(1, 1);
export function setPathRibbonResolution(width: number, height: number): void {
  sharedResolution.set(width, height);
}

// Shared by reference across every ribbon material. The trace cache flips it
// on while baking ribbons into its render target so they write sRGB-encoded
// values there (three forces linearToOutputTexel to identity for render
// targets): blending and MSAA resolve then happen in the same encoded space
// as direct canvas rendering, making cached and directly drawn strokes
// pixel-identical.
const sharedCacheEncode = { value: 0 };
export function setPathRibbonCacheEncode(enabled: boolean): void {
  sharedCacheEncode.value = enabled ? 1 : 0;
}

const VERTEX_SHADER = /* glsl */ `
uniform sampler2D pathTex;
uniform sampler2D colorTex;
uniform float useVertexColor;
uniform int pointCount;
uniform vec2 resolution;
uniform float linewidth;
out vec3 vColor;
${PATH_TEXEL_GLSL}
vec3 fetchPoint(int i) {
  return texelFetch(pathTex, pathTexel(i, pointCount), 0).xyz;
}

void main() {
  // four vertices per segment: corners 0,1 sit on the segment's first point,
  // corners 2,3 on its second; the low bit picks the side of the line
  int segment = gl_VertexID >> 2;
  int corner = gl_VertexID & 3;
  int end = corner >> 1;
  int i = segment + end;
  float side = ((corner & 1) == 0) ? 1.0 : -1.0;

  vColor = mix(vec3(1.0), texelFetch(colorTex, pathTexel(i, pointCount), 0).rgb, useVertexColor);

  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 clipA = mvp * vec4(fetchPoint(segment), 1.0);
  vec4 clipB = mvp * vec4(fetchPoint(segment + 1), 1.0);

  vec2 half_res = 0.5 * resolution;
  vec2 sA = clipA.xy / clipA.w * half_res;
  vec2 sB = clipB.xy / clipB.w * half_res;

  vec2 delta = sB - sA;
  float len = length(delta);
  vec2 dir = len > 1e-6 ? delta / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);

  vec4 clip = (end == 0) ? clipA : clipB;
  clip.xy += normal * (side * 0.5 * linewidth) / half_res * clip.w;
  gl_Position = clip;
}
`;

// linearToOutputTexel comes from three's standard fragment prefix and is
// compiled per render target (sRGB encode onto the canvas, identity into
// render targets). cacheEncode forces the sRGB encode when baking into the
// trace cache — sRGBTransferOETF is the exact function linearToOutputTexel
// aliases for the canvas, so cached strokes blend and resolve in the same
// encoded space as directly drawn ones.
const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 color;
uniform float opacity;
uniform float cacheEncode;
in vec3 vColor;
out vec4 outColor;

void main() {
  vec4 c = vec4(color * vColor, opacity);
  outColor = cacheEncode > 0.5 ? sRGBTransferOETF(c) : linearToOutputTexel(c);
}
`;

// One static index buffer shared by all ribbon geometries: triangles
// (4s, 4s+1, 4s+2) / (4s+1, 4s+3, 4s+2) turn each segment's four corners into
// a quad. Grown geometrically when a longer path appears.
let sharedIndex = new BufferAttribute(new Uint32Array(0), 1);

function ensureSharedIndex(pointCount: number): BufferAttribute {
  const needed = Math.max(0, pointCount - 1) * 6;
  if (sharedIndex.count >= needed) return sharedIndex;
  const capacity = Math.max(needed, sharedIndex.count * 2, 6 * 4096);
  const segments = Math.ceil(capacity / 6);
  const indices = new Uint32Array(segments * 6);
  for (let s = 0; s < segments; s++) {
    const v = 4 * s;
    const o = 6 * s;
    indices[o] = v;
    indices[o + 1] = v + 1;
    indices[o + 2] = v + 2;
    indices[o + 3] = v + 1;
    indices[o + 4] = v + 3;
    indices[o + 5] = v + 2;
  }
  sharedIndex = new BufferAttribute(indices, 1);
  return sharedIndex;
}

export type PathRibbonStyle = {
  color: string;
  opacity: number;
  linewidth: number;
};

const WHITE = new Color(1, 1, 1);

export class PathRibbon {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private geometry: BufferGeometry;
  private textures = new PathTextures();
  private baseColor: Color;

  constructor(style: PathRibbonStyle) {
    // linear working-space color, like the built-in materials; output
    // encoding happens in the fragment shader via linearToOutputTexel
    const color = new Color(style.color);
    this.baseColor = color.clone();
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        pathTex: { value: null },
        colorTex: { value: DUMMY_COLOR_TEXTURE },
        useVertexColor: { value: 0 },
        pointCount: { value: 0 },
        resolution: { value: sharedResolution },
        cacheEncode: sharedCacheEncode,
        linewidth: { value: style.linewidth },
        color: { value: color },
        opacity: { value: style.opacity },
      },
      transparent: style.opacity < 1,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    this.geometry = new BufferGeometry();
    applyHugeBounds(this.geometry);
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  setDepth(enabled: boolean): void {
    this.material.depthTest = enabled;
    this.material.depthWrite = enabled;
  }

  // points: per-point [x, y, z]; colors: optional per-point linear RGBA bytes.
  setPath(
    points: Float32Array,
    pointCount: number,
    colors?: Uint8Array | null,
  ): void {
    this.textures.upload(points, pointCount, colors);
    this.material.uniforms.pathTex!.value = this.textures.path;
    this.material.uniforms.pointCount!.value = pointCount;

    // with per-point colors the uniform must not tint them
    (this.material.uniforms.color!.value as Color).copy(
      colors ? WHITE : this.baseColor,
    );
    this.material.uniforms.colorTex!.value = colors
      ? this.textures.color
      : DUMMY_COLOR_TEXTURE;
    this.material.uniforms.useVertexColor!.value = colors ? 1 : 0;

    this.geometry.setIndex(ensureSharedIndex(pointCount));
    this.geometry.setDrawRange(0, Math.max(0, pointCount - 1) * 6);
  }

  dispose(): void {
    this.textures.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
}
