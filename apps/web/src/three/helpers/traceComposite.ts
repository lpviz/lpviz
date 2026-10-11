import { restartableTimeout } from "@/features/core/timers";
import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { type Camera, CustomBlending, GLSL3, Mesh, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, type Scene, ShaderMaterial, type Texture, WebGLRenderTarget, type WebGLRenderer } from "three";

// how long after its last change a view counts as moving, for both trace impostors
export const VIEW_SETTLE_MS = 160;

/** What a trace impostor substitutes for the pass: its quad scene, and the camera to draw it with (the pass's own when absent). */
export type TracePassImpostor = { scene: Scene; camera?: Camera };

/** What an impostor is handed each frame: the renderer and camera, the frame's inputs, the trace pass's scene and the scenes that occlude it. */
export type TraceFrame = { renderer: WebGLRenderer; camera: Camera; state: State; snapshot: ViewportRenderSnapshot; trace: Scene; occluders: readonly Scene[] };

/** Something that may stand in for the trace pass: `prepare` bakes offscreen and answers with the substitute, or null to render the pass directly. */
export interface TraceImpostor {
  /** the scene the impostor composites through, for compiling its programs ahead of the first trace */
  readonly scene: Scene;
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

// A unit quad that composites an offscreen target onto the canvas, placed by its transform in
// the world or, screen-space, over the whole canvas.
export class CompositeQuad {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

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

  /** The target texture the quad composites, or null between targets. */
  setMap(texture: Texture | null): void {
    this.material.uniforms.map!.value = texture;
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

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// The offscreen target a composite quad maps: rebuilt when the size, the sample count or the
// depth buffer asked for differs, rendered into with the bound target restored afterwards,
// released with the quad unmapped.
export class OffscreenTarget {
  private target: WebGLRenderTarget | null = null;

  constructor(private readonly quad: CompositeQuad) {}

  /** The target as it stands, or null between targets. */
  get current(): WebGLRenderTarget | null {
    return this.target;
  }

  ensure(width: number, height: number, samples: number, depthBuffer: boolean): WebGLRenderTarget {
    if (!this.target || this.target.width !== width || this.target.height !== height || this.target.samples !== samples || this.target.depthBuffer !== depthBuffer) {
      this.target?.dispose();
      this.target = new WebGLRenderTarget(width, height, { samples, depthBuffer, stencilBuffer: false });
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

/**
 * Whether the view is in motion, as an impostor decides it: the numbers that place the view are
 * recorded each frame, and the view counts as moving for VIEW_SETTLE_MS after they last changed.
 */
export class ViewMotion {
  private readonly last: Float64Array;
  private lastChangeAt = -Infinity;

  constructor(size: number) {
    this.last = new Float64Array(size).fill(NaN);
  }

  /** The view's number `i` as of the last frame recorded (NaN before the first). */
  previous(i: number): number {
    return this.last[i]!;
  }

  /** Record this frame's view; true when it differs from the last. */
  update(now: number, view: readonly number[]): boolean {
    let changed = false;
    for (let i = 0; i < view.length; i++) {
      if (view[i] === this.last[i]) continue;
      this.last[i] = view[i]!;
      changed = true;
    }
    if (changed) this.lastChangeAt = now;
    return changed;
  }

  moving(now: number): boolean {
    return now - this.lastChangeAt < VIEW_SETTLE_MS;
  }

  /** Forget the view, so the next frame recorded counts as a change. */
  reset(): void {
    this.last.fill(NaN);
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
