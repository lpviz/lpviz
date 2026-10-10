import { getState } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import type { Camera, Material, Mesh, WebGLRenderer } from "three";
import { OrthographicCamera, Scene, WebGLRenderTarget } from "three";
import { setPathRibbonCacheEncode } from "./helpers/pathRibbon";
import { CompositeQuad, SettleTimer } from "./helpers/traceComposite";

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
const VIEW_SETTLE_MS = 160;

const QUAD_VERTEX_SHADER = /* glsl */ `
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class Trace3DCompositor {
  private renderTarget: WebGLRenderTarget | null = null;
  private quadScene = new Scene();
  private quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad = new CompositeQuad(QUAD_VERTEX_SHADER, 2);
  private materialScratch: Material[] = [];
  private lastViewKey = "";
  private lastViewChangeAt = -Infinity;
  private settle: SettleTimer;

  constructor(requestFrame: () => void) {
    this.settle = new SettleTimer(requestFrame, VIEW_SETTLE_MS);
    this.quadScene.add(this.quad.mesh);
  }

  // Returns the composite quad scene when the pass should go through the
  // offscreen target this frame, or null to render directly.
  prepare(renderer: WebGLRenderer, camera: Camera, traceLinesScene: Scene, occluderScenes: readonly Scene[]): Scene | null {
    const snapshot = getViewportRenderSnapshot();
    const state = getState();
    if (snapshot.mode !== "3d") {
      this.releaseTarget();
      this.lastViewKey = "";
      return null;
    }

    const p = snapshot.perspective;
    const now = performance.now();
    const t = snapshot.target;
    const viewKey =
      `${p.position.x},${p.position.y},${p.position.z},` + `${p.up.x},${p.up.y},${p.up.z},${p.fov},${p.aspect},` + `${t.x},${t.y},${t.z},` + `${state.zScale},${snapshot.transitionZMultiplier}`;
    if (viewKey !== this.lastViewKey) {
      this.lastViewChangeAt = now;
      this.lastViewKey = viewKey;
    }
    const moving = state.isTransitioning3D || now - this.lastViewChangeAt < VIEW_SETTLE_MS;
    if (!moving) {
      return null;
    }
    // the settle frame re-renders the pass directly at full quality
    this.settle.arm();

    const pixelWidth = Math.max(1, Math.round((snapshot.width || 1) * renderer.getPixelRatio()));
    const pixelHeight = Math.max(1, Math.round((snapshot.height || 1) * renderer.getPixelRatio()));
    if (!this.renderTarget || this.renderTarget.width !== pixelWidth || this.renderTarget.height !== pixelHeight) {
      this.renderTarget?.dispose();
      this.renderTarget = new WebGLRenderTarget(pixelWidth, pixelHeight, {
        depthBuffer: true,
        stencilBuffer: false,
      });
      this.quad.setMap(this.renderTarget.texture);
    }

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.renderTarget);
    renderer.clear();
    // depth-only pre-pass so geometry occludes chunks as in direct rendering
    for (const scene of occluderScenes) {
      this.renderDepthOnly(renderer, scene, camera);
    }
    setPathRibbonCacheEncode(true);
    renderer.render(traceLinesScene, camera);
    setPathRibbonCacheEncode(false);
    renderer.setRenderTarget(previousTarget);

    return this.quadScene;
  }

  get camera(): Camera {
    return this.quadCamera;
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

  private releaseTarget(): void {
    if (!this.renderTarget) return;
    this.renderTarget.dispose();
    this.renderTarget = null;
    this.quad.setMap(null);
  }

  dispose(): void {
    this.settle.dispose();
    this.releaseTarget();
    this.quad.dispose();
  }
}
