import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  GLSL3,
  Mesh,
  ShaderMaterial,
  type WebGLRenderer,
} from "three";
import {
  DUMMY_COLOR_TEXTURE,
  PATH_TEXEL_GLSL,
  PathTextures,
} from "./pathTextures";
import { applyHugeBounds } from "./sharedLineMaterials";

// World-space tube rendering for a polyline in the 3D views. A screen-space
// ribbon (pathRibbon.ts) is the right tool in 2D, but in 3D it is a camera-
// facing strip: it has no thickness of its own, so it reads as a flat band
// whose apparent width depends on how each segment happens to face the
// camera. A tube has a circular cross-section, so it looks the same from
// every angle and shades like a solid.
//
// Cost model, chosen to stay in the same league as the ribbon:
//  - One uncapped SIDES-gon prism per segment (2*SIDES vertices, 2*SIDES
//    triangles), generated entirely in the vertex shader from gl_VertexID and
//    the shared path texture: no vertex attributes, one draw call, and a
//    single static index buffer shared by every tube.
//  - Prisms are extended by one radius past each interior joint so consecutive
//    prisms overlap there instead of leaving a notch. The tube is opaque and
//    depth-tested, so the overlap costs nothing visually. (A mitre or a joint
//    sphere would add per-joint geometry for no visible gain at these radii.)
//  - The radius is derived per vertex from its own view depth (pixelRadius *
//    pixelScale * depth), so the tube keeps a constant on-screen thickness
//    everywhere along the path — the same constant-pixel styling as the rest of
//    the app's fat lines — while still being true round geometry at every
//    point. zScale rides along as a uniform rather than object3D.scale.z,
//    which would squash the cross-section.
//  - Shading is a two-term headlight computed from the ring normal (no scene
//    lights are involved): full color where the surface faces the camera,
//    darker toward the silhouette. That gradient is what makes a thin tube
//    read as round instead of as a strip of twice the radius.

const SIDES = 8;
const VERTS_PER_SEGMENT = 2 * SIDES;
const INDICES_PER_SEGMENT = 6 * SIDES;

const VERTEX_SHADER = /* glsl */ `
uniform sampler2D pathTex;
uniform sampler2D colorTex;
uniform float useVertexColor;
uniform int pointCount;
uniform float pixelRadius;
uniform float pixelScale;
uniform float zFactor;
out vec3 vColor;
out vec3 vNormalView;
${PATH_TEXEL_GLSL}
vec3 fetchPoint(int i) {
  vec3 p = texelFetch(pathTex, pathTexel(i, pointCount), 0).xyz;
  p.z *= zFactor;
  return p;
}

const int SIDES = ${SIDES};
const float TAU = 6.28318530718;

void main() {
  // 2*SIDES vertices per segment: ring 0 sits on the segment's first point,
  // ring 1 on its second; the ring index picks the angle around the axis
  int segment = gl_VertexID / (2 * SIDES);
  int local = gl_VertexID - segment * (2 * SIDES);
  int end = local / SIDES;
  int side = local - end * SIDES;

  vec3 a = fetchPoint(segment);
  vec3 b = fetchPoint(segment + 1);
  vec3 axis = b - a;
  float len = length(axis);
  vec3 d = len > 1e-9 ? axis / len : vec3(1.0, 0.0, 0.0);

  // any orthonormal frame around the axis will do: each prism owns its ring
  vec3 ref = abs(d.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 u = normalize(cross(d, ref));
  vec3 v = cross(d, u);
  float angle = TAU * float(side) / float(SIDES);
  vec3 n = cos(angle) * u + sin(angle) * v;

  // world radius for this ring: pixelRadius pixels at the ring centre's
  // view depth (a world offset r at depth w spans r / (w * pixelScale) pixels)
  vec3 centre = (end == 0) ? a : b;
  float depth = max(1e-3, -(modelViewMatrix * vec4(centre, 1.0)).z);
  float radius = pixelRadius * pixelScale * depth;

  // overlap neighbouring prisms at interior joints; path ends stay flush
  float extendA = segment > 0 ? radius : 0.0;
  float extendB = segment < pointCount - 2 ? radius : 0.0;
  vec3 base = (end == 0) ? a - d * extendA : b + d * extendB;

  vColor = mix(vec3(1.0), texelFetch(colorTex, pathTexel(segment + end, pointCount), 0).rgb, useVertexColor);
  vNormalView = normalMatrix * n;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(base + n * radius, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 color;
uniform float opacity;
in vec3 vColor;
in vec3 vNormalView;
out vec4 outColor;

void main() {
  // headlight: the ring normal's view-space z is 1 facing the camera and 0
  // at the silhouette (abs() keeps the far wall consistent under DoubleSide)
  float facing = abs(normalize(vNormalView).z);
  float shade = 0.55 + 0.45 * facing;
  outColor = linearToOutputTexel(vec4(color * vColor * shade, opacity));
}
`;

// One static index buffer shared by all tube geometries: for segment s and
// side j, the quad between ring-0 vertices j, j+1 and ring-1 vertices j, j+1.
// Grown geometrically when a longer path appears.
let sharedIndex = new BufferAttribute(new Uint32Array(0), 1);

function ensureSharedIndex(pointCount: number): BufferAttribute {
  const needed = Math.max(0, pointCount - 1) * INDICES_PER_SEGMENT;
  if (sharedIndex.count >= needed) return sharedIndex;
  const capacity = Math.max(needed, sharedIndex.count * 2, INDICES_PER_SEGMENT * 4096);
  const segments = Math.ceil(capacity / INDICES_PER_SEGMENT);
  const indices = new Uint32Array(segments * INDICES_PER_SEGMENT);
  let o = 0;
  for (let s = 0; s < segments; s++) {
    const ring0 = s * VERTS_PER_SEGMENT;
    const ring1 = ring0 + SIDES;
    for (let j = 0; j < SIDES; j++) {
      const k = (j + 1) % SIDES;
      indices[o++] = ring0 + j;
      indices[o++] = ring0 + k;
      indices[o++] = ring1 + j;
      indices[o++] = ring0 + k;
      indices[o++] = ring1 + k;
      indices[o++] = ring1 + j;
    }
  }
  sharedIndex = new BufferAttribute(indices, 1);
  return sharedIndex;
}

export type PathTubeStyle = {
  color: string;
  opacity: number;
  /** Tube radius in CSS pixels (half the line width). */
  pixelRadius: number;
};

const WHITE = new Color(1, 1, 1);

export class PathTube {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private geometry: BufferGeometry;
  private textures = new PathTextures();
  private baseColor: Color;

  constructor(style: PathTubeStyle) {
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
        pixelRadius: { value: style.pixelRadius },
        pixelScale: { value: 0 },
        zFactor: { value: 1 },
        color: { value: color },
        opacity: { value: style.opacity },
      },
      transparent: style.opacity < 1,
      // depth on so the overlapping prisms resolve into one solid tube ...
      depthTest: true,
      depthWrite: true,
      side: DoubleSide,
    });
    this.geometry = new BufferGeometry();
    applyHugeBounds(this.geometry);
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // ... but against itself only: like the ribbon it replaces, the iterate
    // path always draws over the scene, so the depth left behind by earlier
    // passes is discarded right before it renders. The point sprites that
    // follow in the same pass do not depth-test, so they are unaffected.
    this.mesh.onBeforeRender = (renderer: WebGLRenderer) => {
      renderer.clearDepth();
    };
  }

  // points: per-point [x, y, z] (raw z; see setZFactor); colors: optional
  // per-point linear RGBA bytes.
  setPath(points: Float32Array, pointCount: number, colors?: Uint8Array | null): void {
    this.textures.upload(points, pointCount, colors);
    this.material.uniforms.pathTex!.value = this.textures.path;
    this.material.uniforms.pointCount!.value = pointCount;
    (this.material.uniforms.color!.value as Color).copy(colors ? WHITE : this.baseColor);
    this.material.uniforms.colorTex!.value = colors ? this.textures.color : DUMMY_COLOR_TEXTURE;
    this.material.uniforms.useVertexColor!.value = colors ? 1 : 0;
    this.geometry.setIndex(ensureSharedIndex(pointCount));
    this.geometry.setDrawRange(0, Math.max(0, pointCount - 1) * INDICES_PER_SEGMENT);
  }

  /**
   * World units per CSS pixel per unit of view depth for the current
   * perspective camera: 2 * tan(fov / 2) / viewportHeight.
   */
  setPixelScale(scale: number): void {
    this.material.uniforms.pixelScale!.value = scale;
  }

  /** zScale and the 2D/3D flatten, applied to the path's raw z in the shader. */
  setZFactor(factor: number): void {
    this.material.uniforms.zFactor!.value = factor;
  }

  dispose(): void {
    this.textures.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
}
