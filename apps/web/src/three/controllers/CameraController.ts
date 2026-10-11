import { getViewportRenderSnapshot, subscribeViewportRenderSnapshot } from "@/features/viewport/runtime/channels";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { configurePerspectiveCameraFromSnapshot } from "@lpviz/viewport/projection3d";
import { poseOf, samePerspectivePose } from "@lpviz/viewport/snapshot";
import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import type { SceneManager } from "../SceneManager";

const EPS = 1e-9;

// Poses the two cameras from the render snapshot, one frame after it is published, and tells the
// scene which one to render with.
export class CameraController {
  private ortho = new OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  readonly perspective = new PerspectiveCamera(45, 1, 0.1, 10000);
  // The point the perspective camera looks at, which the orbit controls move too. NaN until the
  // first snapshot is applied, so nothing matches it before then.
  readonly perspectiveTarget = new Vector3(NaN, NaN, NaN);
  private subscriptions = new AbortController();
  private pendingSnapshot = false;

  constructor(private sceneManager: SceneManager) {
    // every 2D snapshot looks straight down from z = 10 with +y up, so the
    // orientation is fixed here once; applySnapshot only moves the camera
    this.ortho.position.set(0, 0, 10);
    this.ortho.lookAt(0, 0, 0);

    subscribeViewportRenderSnapshot(() => {
      this.pendingSnapshot = true;
      this.sceneManager.invalidate("frame");
    }, this.subscriptions.signal);

    this.applySnapshot();
    this.sceneManager.addTick(this.tick);
  }

  private tick = (): void => {
    if (!this.pendingSnapshot) return;
    this.pendingSnapshot = false;
    this.applySnapshot();
  };

  private applySnapshot(): void {
    const snap = getViewportRenderSnapshot();
    this.sceneManager.setCamera(snap.mode === "2d" ? this.ortho : this.perspective);

    if (snap.mode === "2d") {
      const ortho = this.ortho;
      const { left, right, top, bottom, position } = snap.orthographic;
      if (ortho.left !== left || ortho.right !== right || ortho.top !== top || ortho.bottom !== bottom) {
        Object.assign(ortho, { left, right, top, bottom }).updateProjectionMatrix();
      }
      ortho.position.copy(position);
      ortho.updateMatrixWorld();
      return;
    }

    // the orbit controls pose this camera too; a snapshot that echoes their pose changes nothing
    if (this.perspectiveMatches(snap)) return;
    configurePerspectiveCameraFromSnapshot(snap, this.perspective, this.perspectiveTarget);
  }

  private perspectiveMatches(snap: ViewportRenderSnapshot): boolean {
    const camera = this.perspective;
    const lens = snap.perspective;
    return (
      nearlyEqual(camera.fov, lens.fov) &&
      nearlyEqual(camera.aspect, lens.aspect) &&
      nearlyEqual(camera.near, lens.near) &&
      nearlyEqual(camera.far, lens.far) &&
      samePerspectivePose({ position: camera.position, up: camera.up, target: this.perspectiveTarget }, poseOf(snap), EPS)
    );
  }

  dispose(): void {
    this.subscriptions.abort();
    this.sceneManager.removeTick(this.tick);
  }
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS;
}
