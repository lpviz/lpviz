import { getViewport3DControlsConfig, subscribeViewport3DControlsConfig, type ViewportPerspectivePose } from "@/features/viewport/runtime/controls3d";
import { MIN_PERSPECTIVE_DISTANCE } from "@lpviz/viewport/defaults";
import { configurePerspectiveCameraFromSnapshot } from "@lpviz/viewport/projection3d";
import { Plane, Raycaster, Vector2, Vector3, type PerspectiveCamera } from "three";
import type { SceneManager } from "../SceneManager";
import { xyz } from "./CameraController";
import { addListeners, getTouchCenter, getTouchDistance } from "./pointerEvents";

const ROTATE_RADIANS_PER_PIXEL = 0.008;
const MIN_ELEVATION = 0.08;
const MAX_ELEVATION = Math.PI / 2 - 0.05;
const WHEEL_ZOOM_BASE = 1.0015;
const WORLD_UP = new Vector3(0, 0, 1);
const FALLBACK_RIGHT = new Vector3(1, 0, 0);

type ActiveDrag = {
  kind: "rotate" | "pan";
  startClientX: number;
  startClientY: number;
  startTarget: Vector3;
  startPosition: Vector3;
  startDistance: number;
  startYaw: number;
  startElevation: number;
  panRight: Vector3;
  panUp: Vector3;
  unitsPerPixel: number;
};

// The 3D view's orbit controls: left-drag pans in the target plane, right-drag (or two fingers)
// orbits, the wheel (or a pinch) zooms toward the cursor. They move the perspective camera and
// its target directly and report each pose through the 3D controls config, which also tells them
// when they own the view and re-poses the camera from a snapshot when asked.
export class OrbitController {
  private syncToken = -1;
  private config = getViewport3DControlsConfig();
  private readonly unsubscribeConfig: () => void;
  private readonly detachListeners: () => void;
  private activeDrag: ActiveDrag | null = null;
  private readonly wheelAnchorAfter = new Vector3();
  private readonly wheelAnchorBefore = new Vector3();
  private readonly wheelDelta = new Vector3();
  private readonly wheelPlane = new Plane();
  private readonly wheelPlaneNormal = new Vector3();
  private readonly wheelPointerNdc = new Vector2();
  private readonly wheelRaycaster = new Raycaster();

  constructor(
    private readonly sceneManager: SceneManager,
    private readonly camera: PerspectiveCamera,
    /** the point the camera looks at, shared with the camera controller */
    private readonly target: Vector3,
  ) {
    this.unsubscribeConfig = subscribeViewport3DControlsConfig(() => {
      this.config = getViewport3DControlsConfig();
      this.applyConfig();
    });
    this.detachListeners = this.attach(sceneManager.renderer.domElement);
    this.applyConfig();
  }

  private get enabled(): boolean {
    return this.config.enabled && !this.config.blocked;
  }

  private attach(canvas: HTMLCanvasElement): () => void {
    const { camera } = this;
    const pose = (target = this.target): ViewportPerspectivePose => ({
      position: xyz(camera.position),
      up: xyz(camera.up),
      target: xyz(target),
    });

    const emitPose = (target = this.target) => {
      this.target.copy(target);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      this.config.onChange?.(pose(target));
    };

    const orbitOffset = new Vector3();
    const panForward = new Vector3();
    const panBasisRight = new Vector3();
    const panBasisUp = new Vector3();
    const moveDelta = new Vector3();
    const moveTarget = new Vector3();
    let activePointerId: number | null = null;
    let activeTwoFingerOrbit = false;
    let activeTwoFingerStartDistance = 0;
    let activeTwoFingerStartCameraDistance = MIN_PERSPECTIVE_DISTANCE;

    const getOrbitState = () => {
      const offset = orbitOffset.subVectors(camera.position, this.target);
      const distance = Math.max(MIN_PERSPECTIVE_DISTANCE, offset.length());
      return {
        distance,
        yaw: Math.atan2(offset.y, offset.x),
        elevation: Math.asin(Math.max(-1, Math.min(1, offset.z / distance))),
      };
    };

    const getPanBasis = (distance: number) => {
      const forward = panForward.subVectors(this.target, camera.position).normalize();
      const right = panBasisRight.crossVectors(forward, WORLD_UP);
      if (right.lengthSq() < 1e-8) {
        right.copy(FALLBACK_RIGHT);
      } else {
        right.normalize();
      }
      const up = panBasisUp.crossVectors(right, forward).normalize();
      const fov = (camera.fov * Math.PI) / 180;
      const unitsPerPixel = (2 * Math.tan(fov / 2) * Math.max(MIN_PERSPECTIVE_DISTANCE, distance)) / Math.max(1, canvas.clientHeight);
      return { right: right.clone(), up: up.clone(), unitsPerPixel };
    };

    const applyMove = (clientX: number, clientY: number) => {
      const drag = this.activeDrag;
      if (!drag || !this.enabled) return;
      const dx = clientX - drag.startClientX;
      const dy = clientY - drag.startClientY;

      if (drag.kind === "rotate") {
        const yaw = drag.startYaw - dx * ROTATE_RADIANS_PER_PIXEL;
        const elevation = Math.max(MIN_ELEVATION, Math.min(MAX_ELEVATION, drag.startElevation + dy * ROTATE_RADIANS_PER_PIXEL));
        const cosElevation = Math.cos(elevation);
        camera.position.set(
          drag.startTarget.x + drag.startDistance * cosElevation * Math.cos(yaw),
          drag.startTarget.y + drag.startDistance * cosElevation * Math.sin(yaw),
          drag.startTarget.z + drag.startDistance * Math.sin(elevation),
        );
        emitPose(drag.startTarget);
        return;
      }

      const delta = moveDelta
        .copy(drag.panRight)
        .multiplyScalar(-dx * drag.unitsPerPixel)
        .addScaledVector(drag.panUp, dy * drag.unitsPerPixel);
      const target = moveTarget.copy(drag.startTarget).add(delta);
      camera.position.copy(drag.startPosition).add(delta);
      emitPose(target);
    };

    const startDrag = (kind: ActiveDrag["kind"], clientX: number, clientY: number) => {
      if (!this.enabled) return;
      const orbit = getOrbitState();
      const panBasis = getPanBasis(orbit.distance);
      this.activeDrag = {
        kind,
        startClientX: clientX,
        startClientY: clientY,
        startTarget: this.target.clone(),
        startPosition: camera.position.clone(),
        startDistance: orbit.distance,
        startYaw: orbit.yaw,
        startElevation: orbit.elevation,
        panRight: panBasis.right,
        panUp: panBasis.up,
        unitsPerPixel: panBasis.unitsPerPixel,
      };
      canvas.focus();
      this.config.onStart?.();
    };

    const applyZoomDistance = (nextDistance: number) => {
      if (!this.enabled) return;
      const offset = new Vector3().subVectors(camera.position, this.target);
      if (offset.lengthSq() <= 1e-8) return;
      camera.position.copy(this.target).add(offset.normalize().multiplyScalar(Math.min(this.config.maxDistance, Math.max(MIN_PERSPECTIVE_DISTANCE, nextDistance))));
      emitPose();
    };

    const stopDrag = () => {
      if (!this.activeDrag) return false;
      this.activeDrag = null;
      activeTwoFingerOrbit = false;
      activeTwoFingerStartDistance = 0;
      this.config.onEnd?.();
      return true;
    };

    const clearActivePointer = () => {
      if (activePointerId !== null && canvas.hasPointerCapture(activePointerId)) {
        canvas.releasePointerCapture(activePointerId);
      }
      activePointerId = null;
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 && event.button !== 2) return;
      startDrag(event.button === 0 ? "pan" : "rotate", event.clientX, event.clientY);
      if (!this.activeDrag) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (!this.activeDrag || !this.enabled) return;
      applyMove(event.clientX, event.clientY);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (!stopDrag()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      clearActivePointer();
      activeTwoFingerStartDistance = getTouchDistance(event.touches);
      if (activeTwoFingerStartDistance <= 0) return;
      activeTwoFingerStartCameraDistance = getOrbitState().distance;
      const center = getTouchCenter(event.touches);
      startDrag("rotate", center.x, center.y);
      if (!this.activeDrag) return;
      activeTwoFingerOrbit = true;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!activeTwoFingerOrbit || event.touches.length !== 2) return;
      const center = getTouchCenter(event.touches);
      applyMove(center.x, center.y);
      const distance = getTouchDistance(event.touches);
      if (distance > 0 && activeTwoFingerStartDistance > 0) {
        applyZoomDistance(activeTwoFingerStartCameraDistance * (activeTwoFingerStartDistance / distance));
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (!activeTwoFingerOrbit || event.touches.length >= 2) return;
      if (!stopDrag()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (activeTwoFingerOrbit) return;
      if (event.pointerType === "mouse" || !event.isPrimary) return;
      if (event.button !== 0) return;
      startDrag("pan", event.clientX, event.clientY);
      if (!this.activeDrag) return;
      activePointerId = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (activeTwoFingerOrbit) return;
      if (activePointerId !== event.pointerId || !this.activeDrag) return;
      applyMove(event.clientX, event.clientY);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (activeTwoFingerOrbit) return;
      if (activePointerId !== event.pointerId || !this.activeDrag) return;
      clearActivePointer();
      stopDrag();
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleWheel = (event: WheelEvent) => {
      if (!this.enabled) return;
      if (event.shiftKey) return;
      const dominantDelta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (dominantDelta === 0) return;

      const offset = new Vector3().subVectors(camera.position, this.target);
      const distance = Math.max(MIN_PERSPECTIVE_DISTANCE, offset.length());
      const zoomFactor = Math.pow(WHEEL_ZOOM_BASE, dominantDelta);
      const nextDistance = Math.min(this.config.maxDistance, Math.max(MIN_PERSPECTIVE_DISTANCE, distance * zoomFactor));
      if (!Number.isFinite(nextDistance)) return;

      // zoom toward the cursor: the world point under it in the target plane stays put
      const rect = canvas.getBoundingClientRect();
      const hasCursorAnchor = rect.width > 0 && rect.height > 0 && this.wheelPlaneNormal.subVectors(this.target, camera.position).normalize().lengthSq() > 0;
      let anchoredZoom = false;

      if (hasCursorAnchor) {
        this.wheelPointerNdc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
        this.wheelPlane.setFromNormalAndCoplanarPoint(this.wheelPlaneNormal, this.target);
        camera.updateMatrixWorld();
        this.wheelRaycaster.setFromCamera(this.wheelPointerNdc, camera);
        anchoredZoom = this.wheelRaycaster.ray.intersectPlane(this.wheelPlane, this.wheelAnchorBefore) !== null;
      }

      camera.position.copy(this.target).add(offset.normalize().multiplyScalar(nextDistance));
      if (anchoredZoom) {
        camera.updateMatrixWorld();
        this.wheelRaycaster.setFromCamera(this.wheelPointerNdc, camera);
        if (this.wheelRaycaster.ray.intersectPlane(this.wheelPlane, this.wheelAnchorAfter)) {
          this.wheelDelta.subVectors(this.wheelAnchorBefore, this.wheelAnchorAfter);
          camera.position.add(this.wheelDelta);
          this.target.add(this.wheelDelta);
        }
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.config.onStart?.();
      emitPose();
      this.config.onEnd?.();
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!this.enabled) return;
      event.preventDefault();
    };

    const removeListeners = addListeners([
      [canvas, "mousedown", handleMouseDown],
      [canvas, "pointerdown", handlePointerDown],
      [canvas, "pointermove", handlePointerMove],
      [canvas, "pointerup", handlePointerUp],
      [canvas, "pointercancel", handlePointerUp],
      [canvas, "touchstart", handleTouchStart, { passive: false }],
      [window, "touchmove", handleTouchMove, { passive: false }],
      [window, "touchend", handleTouchEnd, { passive: false }],
      [window, "touchcancel", handleTouchEnd, { passive: false }],
      [window, "mousemove", handleMouseMove],
      [window, "mouseup", handleMouseUp],
      [canvas, "wheel", handleWheel, { passive: false }],
      [canvas, "contextmenu", handleContextMenu],
    ]);

    return () => {
      removeListeners();
      this.activeDrag = null;
      clearActivePointer();
      activeTwoFingerOrbit = false;
      activeTwoFingerStartDistance = 0;
    };
  }

  // Re-pose the camera from the config's snapshot when the runtime asks (a bumped sync token).
  private applyConfig(): void {
    if (this.syncToken === this.config.syncToken) {
      return;
    }
    this.syncToken = this.config.syncToken;
    configurePerspectiveCameraFromSnapshot(this.config.snapshot, this.camera, this.target);
    this.sceneManager.invalidate({ layers: false });
  }

  dispose(): void {
    this.unsubscribeConfig();
    this.detachListeners();
  }
}
