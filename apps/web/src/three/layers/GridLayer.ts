import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { Color, DoubleSide, GLSL3, Mesh, PlaneGeometry, ShaderMaterial } from "three";
import { RENDER_ORDER } from "../helpers/renderOrder";
import type { Layer } from "../Layer";

const GRID_COLOR = "#e0e0e0";
const AXIS_COLOR = "#707070";

// Fragment-shader grid on a single static quad: unit lines and axes are
// computed per pixel from world coordinates, so pan/zoom/orbit and 2D/3D
// transitions never rebuild any geometry (the old line-segment grid
// re-tessellated on every zoom frame, up to ~16k segments in 3D). Lines are
// one device pixel with derivative-based coverage, which also fades the grid
// out naturally instead of aliasing when it gets denser than the pixel grid.
//
// The quad is kept modest (fp32 varyings wobble at deep zoom when vertex
// coordinates are huge) and recentered onto the integer-snapped camera
// target when the view wanders; integer shifts leave fract() untouched.
const GRID_HALF_EXTENT = 8192;
const RECENTER_THRESHOLD = 2048;

const VERTEX_SHADER = /* glsl */ `
out vec2 vWorld;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorld = worldPosition.xy;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 gridColor;
uniform vec3 axisColor;
in vec2 vWorld;
out vec4 outColor;

void main() {
  vec2 fw = fwidth(vWorld);
  // pixel distance to the nearest integer grid line on each axis
  vec2 toGrid = abs(fract(vWorld + 0.5) - 0.5) / fw;
  float gridLine = 1.0 - min(min(toGrid.x, toGrid.y), 1.0);
  vec2 toAxis = abs(vWorld) / fw;
  float axisLine = 1.0 - min(min(toAxis.x, toAxis.y), 1.0);
  float alpha = max(gridLine, axisLine);
  if (alpha <= 0.001) discard;
  vec3 color = mix(gridColor, axisColor, axisLine / alpha);
  outColor = linearToOutputTexel(vec4(color, alpha));
}
`;

export class GridLayer implements Layer {
  readonly object3D: Mesh;
  readonly renderPass = "background" as const;
  readonly invalidationKeys = ["grid"] as const;
  private material: ShaderMaterial;
  private centerX = 0;
  private centerY = 0;

  constructor() {
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        gridColor: { value: new Color(GRID_COLOR) },
        axisColor: { value: new Color(AXIS_COLOR) },
      },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    const mesh = new Mesh(new PlaneGeometry(GRID_HALF_EXTENT * 2, GRID_HALF_EXTENT * 2), this.material);
    mesh.renderOrder = RENDER_ORDER.grid;
    mesh.frustumCulled = false;
    this.object3D = mesh;
  }

  update(): void {
    const target = getViewportRenderSnapshot().target;
    if (Math.abs(target.x - this.centerX) > RECENTER_THRESHOLD || Math.abs(target.y - this.centerY) > RECENTER_THRESHOLD) {
      this.centerX = Math.round(target.x);
      this.centerY = Math.round(target.y);
      this.object3D.position.set(this.centerX, this.centerY, 0);
    }
  }

  dispose(): void {
    this.object3D.geometry.dispose();
    this.material.dispose();
  }
}
