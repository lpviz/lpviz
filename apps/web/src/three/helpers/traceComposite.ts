import { restartableTimeout } from "@/features/core/timers";
import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { type Camera, CustomBlending, GLSL3, Mesh, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, type Scene, ShaderMaterial, type Texture, WebGLRenderTarget, type WebGLRenderer } from "three";

// how long after its last change a view counts as moving, for both trace impostors
export const VIEW_SETTLE_MS = 160;

/** What a trace impostor substitutes for the pass: its quad scene, and the camera to draw it with (the pass's own when absent). */
export type TracePassImpostor = { scene: Scene; camera?: Camera };

/** What an impostor is handed each frame: the renderer and camera, the frame's inputs, the pass's scene and the scenes that occlude it. */
export type TraceFrame = { renderer: WebGLRenderer; camera: Camera; state: State; snapshot: ViewportRenderSnapshot; traceLines: Scene; occluders: readonly Scene[] };

/** Something that may stand in for the traceLines pass: `prepare` bakes offscreen and answers with the substitute, or null to render the pass directly. */
export interface TraceImpostor {
  prepare(frame: TraceFrame): TracePassImpostor | null;
  dispose(): void;
}

/** Whether a scene has nothing visible to render. */
export const drawsNothing = (scene: Scene): boolean => scene.children.every((child) => !child.visible);

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

// The offscreen target a composite quad maps: rebuilt when the size or the sample count asked for
// differs, rendered into with the bound target restored afterwards, released with the quad unmapped.
export class OffscreenTarget {
  private target: WebGLRenderTarget | null = null;

  constructor(
    private readonly quad: CompositeQuad,
    private readonly options: { depthBuffer: boolean },
  ) {}

  /** The target as it stands, or null between targets. */
  get current(): WebGLRenderTarget | null {
    return this.target;
  }

  ensure(width: number, height: number, samples: number): WebGLRenderTarget {
    if (!this.target || this.target.width !== width || this.target.height !== height || this.target.samples !== samples) {
      this.target?.dispose();
      this.target = new WebGLRenderTarget(width, height, { samples, depthBuffer: this.options.depthBuffer, stencilBuffer: false });
      this.quad.setMap(this.target.texture);
    }
    return this.target;
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
    this.quad.setMap(null);
  }
}

// Demand-driven rendering: a moving view needs one more frame once it settles
// (the crisp exact-zoom rebuild, the direct full-quality pass, the trailing
// fold) that nothing else would schedule. arm() is a no-op while one is
// pending.
export class SettleTimer {
  private readonly timer = restartableTimeout();

  constructor(
    private readonly requestFrame: () => void,
    private readonly delayMs: number,
  ) {}

  arm(): void {
    if (!this.timer.pending) this.timer.schedule(this.requestFrame, this.delayMs);
  }

  dispose(): void {
    this.timer.clear();
  }
}
