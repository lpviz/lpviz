import type { Camera, Scene, WebGLRenderer } from "three";

// A render pass may delegate to an impostor that substitutes a cheaper render
// (e.g. a world-anchored quad compositing a cached offscreen target) for the
// pass's own scene. This keeps SceneManager's render loop generic — it knows it
// renders passes in order, not that the trace pass has a caching system.
export type ImpostorResult =
  // render this scene+camera instead of the pass scene
  | { scene: Scene; camera: Camera }
  // render nothing for this pass this frame
  | "skip"
  // no substitution — render the pass scene directly
  | null;

export interface ImpostorStrategy {
  prepare(renderer: WebGLRenderer, camera: Camera, passScene: Scene): ImpostorResult;
}
