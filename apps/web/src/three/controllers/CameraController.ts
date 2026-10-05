import { resetViewportCameraRefs, setViewportCameraRefs } from "@/features/viewport/runtime/cameraRefs";
import { getViewportRenderSnapshot, subscribeFullViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { OrthographicCamera, PerspectiveCamera } from "three";
import type { SceneManager } from "../SceneManager";

const EPS = 1e-9;

export class CameraController {
  private ortho: OrthographicCamera;
  private perspective: PerspectiveCamera;
  private unsubscribe: () => void;
  private pendingSnapshot = false;
  private lastOrthoProjection: { left: number; right: number; top: number; bottom: number } | null = null;
  private lastPerspectiveProjection: { fov: number; aspect: number; near: number; far: number } | null = null;
  private orthoOriented = false;

  constructor(private sceneManager: SceneManager) {
    this.ortho = new OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.perspective = new PerspectiveCamera(45, 1, 0.1, 10000);

    setViewportCameraRefs({
      ortho: this.ortho,
      perspective: this.perspective,
    });

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
    const nextCamera = snap.mode === "2d" ? this.ortho : this.perspective;
    this.sceneManager.setCamera(nextCamera);

    if (snap.mode === "2d") {
      const projectionChanged =
        !this.lastOrthoProjection ||
        this.lastOrthoProjection.left !== snap.orthographic.left ||
        this.lastOrthoProjection.right !== snap.orthographic.right ||
        this.lastOrthoProjection.top !== snap.orthographic.top ||
        this.lastOrthoProjection.bottom !== snap.orthographic.bottom;
      if (projectionChanged) {
        this.ortho.left = snap.orthographic.left;
        this.ortho.right = snap.orthographic.right;
        this.ortho.top = snap.orthographic.top;
        this.ortho.bottom = snap.orthographic.bottom;
        this.ortho.updateProjectionMatrix();
        this.lastOrthoProjection = {
          left: snap.orthographic.left,
          right: snap.orthographic.right,
          top: snap.orthographic.top,
          bottom: snap.orthographic.bottom,
        };
      }
      this.ortho.position.set(snap.orthographic.position.x, snap.orthographic.position.y, snap.orthographic.position.z);
      if (!this.orthoOriented) {
        this.ortho.up.set(0, 1, 0);
        this.ortho.lookAt(snap.orthographic.position.x, snap.orthographic.position.y, 0);
        this.orthoOriented = true;
      }
      this.ortho.updateMatrixWorld();
      return;
    }

    if (this.perspectiveAlreadyMatchesSnapshot()) {
      return;
    }

    const projectionChanged =
      !this.lastPerspectiveProjection ||
      this.lastPerspectiveProjection.fov !== snap.perspective.fov ||
      this.lastPerspectiveProjection.aspect !== snap.perspective.aspect ||
      this.lastPerspectiveProjection.near !== snap.perspective.near ||
      this.lastPerspectiveProjection.far !== snap.perspective.far;
    if (projectionChanged) {
      this.perspective.fov = snap.perspective.fov;
      this.perspective.aspect = snap.perspective.aspect;
      this.perspective.near = snap.perspective.near;
      this.perspective.far = snap.perspective.far;
      this.perspective.updateProjectionMatrix();
      this.lastPerspectiveProjection = {
        fov: snap.perspective.fov,
        aspect: snap.perspective.aspect,
        near: snap.perspective.near,
        far: snap.perspective.far,
      };
    }
    this.perspective.position.set(snap.perspective.position.x, snap.perspective.position.y, snap.perspective.position.z);
    this.perspective.up.set(snap.perspective.up.x, snap.perspective.up.y, snap.perspective.up.z);
    this.perspective.lookAt(snap.target.x, snap.target.y, snap.target.z);
    this.perspective.updateMatrixWorld();
    this.perspective.userData.lpvizLookAtTarget = {
      x: snap.target.x,
      y: snap.target.y,
      z: snap.target.z,
    };
  }

  private perspectiveAlreadyMatchesSnapshot(): boolean {
    const snap = getViewportRenderSnapshot();
    const target = this.perspective.userData.lpvizLookAtTarget as { x?: number; y?: number; z?: number } | undefined;
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
      !!target &&
      nearlyEqual(target.x, snap.target.x) &&
      nearlyEqual(target.y, snap.target.y) &&
      nearlyEqual(target.z, snap.target.z)
    );
  }

  dispose(): void {
    this.unsubscribe();
    this.sceneManager.removeTick(this.tick);
    resetViewportCameraRefs();
  }
}

function nearlyEqual(a: number | undefined, b: number): boolean {
  return a !== undefined && Math.abs(a - b) <= EPS;
}
