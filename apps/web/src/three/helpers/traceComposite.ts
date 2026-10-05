import { CustomBlending, GLSL3, Mesh, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, ShaderMaterial } from "three";

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
export function makeCompositeQuad(vertexShader: string, size: number): { mesh: Mesh; material: ShaderMaterial } {
  const material = new ShaderMaterial({
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
  const mesh = new Mesh(new PlaneGeometry(size, size), material);
  mesh.frustumCulled = false;
  return { mesh, material };
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
