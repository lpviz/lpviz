import { getViewportRenderSnapshot, subscribeFullViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import type { SceneManager } from "../SceneManager";

const EPS = 1e-9;

// a plain {x, y, z} copy, as the viewport runtime's pose/snapshot types want
export const xyz = ({ x, y, z }: { x: number; y: number; z: number }) => ({ x, y, z });

type PerspectiveProjection = { fov: number; aspect: number; near: number; far: number };

export class CameraController {
  private ortho = new OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  readonly perspective = new PerspectiveCamera(45, 1, 0.1, 10000);
  // The point the perspective camera looks at, which the orbit controls move too. NaN until the
  // first snapshot is applied, so nothing matches it before then.
  readonly perspectiveTarget = new Vector3(NaN, NaN, NaN);
  private unsubscribe: () => void;
  private pendingSnapshot = false;
  // tracked apart from the camera's own fields, which the orbit controls also
  // write when they sync from their config
  private lastPerspectiveProjection: PerspectiveProjection | null = null;

  constructor(private sceneManager: SceneManager) {
    // every 2D snapshot looks straight down from z = 10 with +y up, so the
    // orientation is fixed here once; applySnapshot only moves the camera
    this.ortho.position.set(0, 0, 10);
    this.ortho.lookAt(0, 0, 0);

    this.unsubscribe = subscribeFullViewportRenderSnapshot(() => {
      this.pendingSnapshot = true;
      this.sceneManager.invalidate({ layers: false });
    });

    this.applySnapshot();
    this.sceneManager.addTick(this.tick);
  }

  private tick = (): void => {
    if (!this.pendingSnapshot) {
      return;
    }
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

    if (this.perspectiveAlreadyMatchesSnapshot()) {
      return;
    }

    const { fov, aspect, near, far, position, up } = snap.perspective;
    const last = this.lastPerspectiveProjection;
    if (!last || last.fov !== fov || last.aspect !== aspect || last.near !== near || last.far !== far) {
      this.lastPerspectiveProjection = { fov, aspect, near, far };
      Object.assign(this.perspective, this.lastPerspectiveProjection).updateProjectionMatrix();
    }
    this.perspective.position.copy(position);
    this.perspective.up.copy(up);
    this.perspectiveTarget.set(snap.target.x, snap.target.y, snap.target.z);
    this.perspective.lookAt(this.perspectiveTarget);
    this.perspective.updateMatrixWorld();
  }

  private perspectiveAlreadyMatchesSnapshot(): boolean {
    const snap = getViewportRenderSnapshot();
    const target = this.perspectiveTarget;
    return (
      nearlyEqual(this.perspective.fov, snap.perspective.fov) &&
      nearlyEqual(this.perspective.aspect, snap.perspective.aspect) &&
      nearlyEqual(this.perspective.near, snap.perspective.near) &&
      nearlyEqual(this.perspective.far, snap.perspective.far) &&
      nearlyEqual(this.perspective.position.x, snap.perspective.position.x) &&
      nearlyEqual(this.perspective.position.y, snap.perspective.position.y) &&
      nearlyEqual(this.perspective.position.z, snap.perspective.position.z) &&
      nearlyEqual(this.perspective.up.x, snap.perspective.up.x) &&
      nearlyEqual(this.perspective.up.y, snap.perspective.up.y) &&
      nearlyEqual(this.perspective.up.z, snap.perspective.up.z) &&
      nearlyEqual(target.x, snap.target.x) &&
      nearlyEqual(target.y, snap.target.y) &&
      nearlyEqual(target.z, snap.target.z)
    );
  }

  dispose(): void {
    this.unsubscribe();
    this.sceneManager.removeTick(this.tick);
  }
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS;
}
