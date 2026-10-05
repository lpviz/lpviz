import type { Camera, Scene, WebGLRenderer } from "three";
import type { ImpostorResult, ImpostorStrategy } from "./ImpostorStrategy";
import { Trace3DCompositor } from "./Trace3DCompositor";
import { TraceCache } from "./TraceCache";

function allHidden(scene: Scene): boolean {
  return scene.children.every((c) => !c.visible);
}

// The trace-lines pass impostor. In 2D it composites the trace from a
// world-anchored accumulation cache (so neither camera motion nor a trace
// append re-renders baked chunks); while the 3D view is in motion it composites
// from a single-sample offscreen render instead of hitting the MSAA canvas
// directly. Owns the TraceCache and Trace3DCompositor so SceneManager doesn't
// have to know either exists.
export class TracePassImpostor implements ImpostorStrategy {
  private readonly traceCache: TraceCache;
  private readonly trace3D: Trace3DCompositor;

  constructor(
    requestFrame: () => void,
    private readonly occluderScenes: () => Scene[],
  ) {
    this.traceCache = new TraceCache(requestFrame);
    this.trace3D = new Trace3DCompositor(requestFrame);
  }

  prepare(renderer: WebGLRenderer, camera: Camera, passScene: Scene): ImpostorResult {
    const quad = this.traceCache.prepare(renderer, passScene);
    if (quad) {
      return allHidden(quad) ? "skip" : { scene: quad, camera };
    }
    if (passScene.children.length > 0 && !allHidden(passScene)) {
      const composited = this.trace3D.prepare(renderer, camera, passScene, this.occluderScenes());
      if (composited) {
        return { scene: composited, camera: this.trace3D.camera };
      }
    }
    return null;
  }

  // A flagless invalidate (e.g. layer-content change) must drop the cached bake.
  markContentDirty(): void {
    this.traceCache.markContentDirty();
  }

  dispose(): void {
    this.traceCache.dispose();
    this.trace3D.dispose();
  }
}
