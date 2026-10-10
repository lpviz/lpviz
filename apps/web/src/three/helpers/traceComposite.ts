import { CustomBlending, GLSL3, Mesh, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, ShaderMaterial, type Texture } from "three";

// Rendering translucent strokes onto a transparent black target yields
// premultiplied alpha, so the composite uses (ONE, ONE_MINUS_SRC_ALPHA).
// The ribbons bake sRGB-encoded values into the targets (see cacheEncode in
// pathRibbon.ts), so blending and MSAA resolve happen in the same encoded
// space as direct canvas rendering and the composite is a pure passthrough.
const QUAD_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D map;
in vec2 vUv;
out vec4 outColor;

void main() {
  outColor = texture(map, vUv);
}
`;

// A size x size quad that composites an offscreen target onto the canvas;
// the vertex shader decides where it lands (world-anchored or full-screen).
export class CompositeQuad {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(vertexShader: string, size: number) {
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader: QUAD_FRAGMENT_SHADER,
      uniforms: { map: { value: null } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    this.mesh = new Mesh(new PlaneGeometry(size, size), this.material);
    this.mesh.frustumCulled = false;
  }

  /** The target texture the quad composites, or null between targets. */
  setMap(texture: Texture | null): void {
    this.material.uniforms.map!.value = texture;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// Demand-driven rendering: a moving view needs one more frame once it settles
// (the crisp exact-zoom rebuild, the direct full-quality pass, the trailing
// fold) that nothing else would schedule. arm() is a no-op while one is
// pending.
export class SettleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly requestFrame: () => void,
    private readonly delayMs: number,
  ) {}

  arm(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.requestFrame();
    }, this.delayMs);
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
