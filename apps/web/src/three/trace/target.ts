import { CustomBlending, GLSL3, Mesh, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, ShaderMaterial, type WebGLRenderer, WebGLRenderTarget } from "three";

// Rendering translucent strokes onto a transparent black target yields
// premultiplied alpha, so the composite uses (ONE, ONE_MINUS_SRC_ALPHA).
// The ribbons bake sRGB-encoded values into the targets (see cacheEncode in
// screenUniforms.ts), so blending and MSAA resolve happen in the same encoded
// space as direct canvas rendering and the composite is a pure passthrough.
const QUAD_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D map;
in vec2 vUv;
out vec4 outColor;

void main() {
  outColor = texture(map, vUv);
}
`;

// The unit quad lands where its transform puts it: in the world, through the camera, or, when
// `screenSpace` is set, in clip space with no camera at all (a scale of 2 then spans the canvas).
const QUAD_VERTEX_SHADER = /* glsl */ `
uniform float screenSpace;
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = screenSpace > 0.5 ? vec4((modelMatrix * vec4(position, 1.0)).xy, 0.0, 1.0) : projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// A bake target and the unit quad that composites it onto the canvas, placed by its transform in
// the world or, screen-space, over the whole canvas. The target is rebuilt when the size, the
// sample count or the depth buffer asked for differs, rendered into with the bound target restored
// afterwards, and released with the quad unmapped; `start`/`end` are the sequence range of the
// chunks baked into it.
export class CompositedTarget {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private target: WebGLRenderTarget | null = null;
  /** the live chunks baked into the target, by append sequence: [start, end) */
  start = 0;
  end = 0;

  constructor() {
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VERTEX_SHADER,
      fragmentShader: QUAD_FRAGMENT_SHADER,
      uniforms: { map: { value: null }, screenSpace: { value: 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material);
    this.mesh.frustumCulled = false;
  }

  /** The target as it stands, or null between targets. */
  get current(): WebGLRenderTarget | null {
    return this.target;
  }

  /** Anchor the quad over the `width` x `height` world rect centred at (x, y). */
  placeInWorld(x: number, y: number, width: number, height: number): void {
    this.material.uniforms.screenSpace!.value = 0;
    this.mesh.position.set(x, y, 0);
    this.mesh.scale.set(width, height, 1);
  }

  /** Spread the quad over the whole canvas, whatever the camera. */
  placeOnScreen(): void {
    this.material.uniforms.screenSpace!.value = 1;
    this.mesh.position.set(0, 0, 0);
    this.mesh.scale.set(2, 2, 1);
  }

  ensure(width: number, height: number, samples: number, depthBuffer: boolean): void {
    if (this.target && this.target.width === width && this.target.height === height && this.target.samples === samples && this.target.depthBuffer === depthBuffer) return;
    this.target?.dispose();
    this.target = new WebGLRenderTarget(width, height, { samples, depthBuffer, stencilBuffer: false });
    this.material.uniforms.map!.value = this.target.texture;
  }

  /** Run `render` into the target (cleared first when asked) and restore whatever target was bound. */
  renderInto(renderer: WebGLRenderer, clear: boolean, render: () => void): void {
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    if (clear) renderer.clear();
    render();
    renderer.setRenderTarget(previous);
  }

  release(): void {
    if (!this.target) return;
    this.target.dispose();
    this.target = null;
    this.material.uniforms.map!.value = null;
  }

  dispose(): void {
    this.release();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
