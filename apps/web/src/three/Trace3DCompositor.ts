import { getState } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import type { Camera, Material, Mesh, WebGLRenderer } from "three";
import { OrthographicCamera, Scene } from "three";
import { bakePathRibbons } from "./helpers/pathRibbon";
import { CompositeQuad, OffscreenTarget, SettleTimer, type TracePassImpostor, VIEW_SETTLE_MS } from "./helpers/traceComposite";

// Motion-time compositor for the trace-constraints pass in 3D mode.
//
// A perspective view cannot reuse a cached billboard across frames (parallax),
// so orbiting re-renders every trace chunk every frame. That render is fill
// bound: blending millions of overlapping stroke fragments into the 4x
// multisampled canvas is what blows the frame budget, not the vertex work.
// While the 3D view is in motion (orbit, zScale drag, the 2D/3D transition),
// the chunks render into a single-sample offscreen target instead and reach
// the canvas as one composited quad — aliasing on translucent strokes is
// invisible mid-motion. Once the view settles, the pass renders directly
// again at full quality.
//
// Depth semantics match direct rendering: the offscreen target has its own
// depth buffer, primed by a color-masked pre-pass over the scenes that draw
// depth-writing geometry before the trace pass (polytope fill and edges,
// objective), so chunks occlude each other and are occluded by geometry
// exactly as they are when drawn directly.

const QUAD_VERTEX_SHADER = /* glsl */ `
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class Trace3DCompositor {
  private quadScene = new Scene();
  private quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad = new CompositeQuad(QUAD_VERTEX_SHADER, 2);
  private readonly target = new OffscreenTarget(this.quad, { depthBuffer: true });
  private materialScratch: Material[] = [];
  // the view the last frame was composited for, as the numbers that place the camera
  private readonly lastView = new Float64Array(13).fill(NaN);
  private lastViewChangeAt = -Infinity;
  private settle: SettleTimer;

  constructor(requestFrame: () => void) {
    this.settle = new SettleTimer(requestFrame, VIEW_SETTLE_MS);
    this.quadScene.add(this.quad.mesh);
  }

  // Returns the composite quad when the pass should go through the offscreen
  // target this frame, or null to render directly.
  prepare(renderer: WebGLRenderer, camera: Camera, traceLinesScene: Scene, occluderScenes: readonly Scene[]): TracePassImpostor | null {
    const snapshot = getViewportRenderSnapshot();
    const state = getState();
    if (snapshot.mode !== "3d") {
      this.target.release();
      this.lastView.fill(NaN);
      return null;
    }

    const p = snapshot.perspective;
    const t = snapshot.target;
    const now = performance.now();
    if (this.viewChanged([p.position.x, p.position.y, p.position.z, p.up.x, p.up.y, p.up.z, p.fov, p.aspect, t.x, t.y, t.z, state.zScale, snapshot.transitionZMultiplier])) {
      this.lastViewChangeAt = now;
    }
    const moving = state.isTransitioning3D || now - this.lastViewChangeAt < VIEW_SETTLE_MS;
    if (!moving) {
      return null;
    }
    // the settle frame re-renders the pass directly at full quality
    this.settle.arm();

    const pixelWidth = Math.max(1, Math.round((snapshot.width || 1) * renderer.getPixelRatio()));
    const pixelHeight = Math.max(1, Math.round((snapshot.height || 1) * renderer.getPixelRatio()));
    this.target.ensure(pixelWidth, pixelHeight, 0);
    this.target.renderInto(renderer, true, () => {
      // depth-only pre-pass so geometry occludes chunks as in direct rendering
      for (const scene of occluderScenes) {
        this.renderDepthOnly(renderer, scene, camera);
      }
      bakePathRibbons(() => renderer.render(traceLinesScene, camera));
    });

    return { scene: this.quadScene, camera: this.quadCamera };
  }

  // Whether `view` differs from the last one, which it then becomes.
  private viewChanged(view: readonly number[]): boolean {
    let changed = false;
    for (let i = 0; i < view.length; i++) {
      if (view[i] === this.lastView[i]) continue;
      this.lastView[i] = view[i]!;
      changed = true;
    }
    return changed;
  }

  private renderDepthOnly(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    const touched = this.materialScratch;
    touched.length = 0;
    scene.traverse((object) => {
      const material = (object as Mesh).material as Material | undefined;
      if (material && !Array.isArray(material) && material.depthWrite && material.colorWrite) {
        material.colorWrite = false;
        touched.push(material);
      }
    });
    if (touched.length > 0) {
      renderer.render(scene, camera);
      for (const material of touched) material.colorWrite = true;
    }
    touched.length = 0;
  }

  dispose(): void {
    this.settle.dispose();
    this.target.release();
    this.quad.dispose();
  }
}
