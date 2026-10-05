import { getViewportCameraRefs, subscribeViewportCameraRefs } from "@/features/viewport/runtime/cameraRefs";
import { getViewport2DControlsConfig, isViewport2DPanActive, startViewport2DPan, stopViewport2DPan, updateViewport2DPan, zoomViewport2DAtCanvasPoint } from "@/features/viewport/runtime/controls2d";
import { getViewport3DControlsConfig, subscribeViewport3DControlsConfig, type ViewportPerspectivePose } from "@/features/viewport/runtime/controls3d";
import { Plane, Raycaster, Vector2, Vector3, type PerspectiveCamera } from "three";
import type { SceneManager } from "../SceneManager";

const WHEEL_ZOOM_FACTOR = 1.05;
const ROTATE_RADIANS_PER_PIXEL = 0.008;
const MIN_ELEVATION = 0.08;
const MAX_ELEVATION = Math.PI / 2 - 0.05;
const MIN_DISTANCE = 10;
const WORLD_UP = new Vector3(0, 0, 1);
const FALLBACK_RIGHT = new Vector3(1, 0, 0);

type Active3DDrag = {
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

export class ControlsController {
  private syncToken = -1;
  private applyingSnapshot = false;
  private controlsConfig = getViewport3DControlsConfig();
  private perspectiveCamera = getViewportCameraRefs().perspective;
  private unsubscribeConfig: () => void;
  private unsubscribeCameras: () => void;
  private cleanup2D: (() => void) | null = null;
  private cleanup3D: (() => void) | null = null;
  private controlsEnabled = false;
  private controlsMaxDistance = 1000;
  private controlsTarget = new Vector3();
  private active3DDrag: Active3DDrag | null = null;
  private wheelAnchorAfter = new Vector3();
  private wheelAnchorBefore = new Vector3();
  private wheelDelta = new Vector3();
  private wheelPlane = new Plane();
  private wheelPlaneNormal = new Vector3();
  private wheelPointerNdc = new Vector2();
  private wheelRaycaster = new Raycaster();

  constructor(private sceneManager: SceneManager) {
    const canvas = sceneManager.renderer.domElement;
    this.setup2DListeners(canvas);

    this.unsubscribeConfig = subscribeViewport3DControlsConfig(() => {
      this.controlsConfig = getViewport3DControlsConfig();
      this.applyControlsConfig();
    });

    this.unsubscribeCameras = subscribeViewportCameraRefs(() => {
      const next = getViewportCameraRefs().perspective;
      if (next !== this.perspectiveCamera) {
        this.perspectiveCamera = next;
        this.dispose3DControls();
        if (next) {
          this.setup3DControls(next, canvas);
        }
      }
    });

    if (this.perspectiveCamera) {
      this.setup3DControls(this.perspectiveCamera, canvas);
    }

    this.applyControlsConfig();
  }

  private setup2DListeners(canvas: HTMLCanvasElement): void {
    let activePointerPanId: number | null = null;
    let activePinch: {
      startDistance: number;
      startScaleFactor: number;
    } | null = null;

    const startPan = (clientX: number, clientY: number) => startViewport2DPan(clientX, clientY, canvas.getBoundingClientRect());

    const getTouchCenter = (touches: TouchList) => ({
      x: (touches[0]!.clientX + touches[1]!.clientX) / 2,
      y: (touches[0]!.clientY + touches[1]!.clientY) / 2,
    });

    const getTouchDistance = (touches: TouchList) => Math.hypot(touches[1]!.clientX - touches[0]!.clientX, touches[1]!.clientY - touches[0]!.clientY);

    const clearActivePointerPan = () => {
      if (activePointerPanId !== null && canvas.hasPointerCapture(activePointerPanId)) {
        canvas.releasePointerCapture(activePointerPanId);
      }
      activePointerPanId = null;
    };

    const startPinch = (event: TouchEvent) => {
      if (event.touches.length !== 2) return false;
      const startDistance = getTouchDistance(event.touches);
      if (startDistance <= 0) return false;
      const config = getViewport2DControlsConfig();
      if (!config.enabled || config.blocked) return false;
      activePinch = {
        startDistance,
        startScaleFactor: config.state.scaleFactor,
      };
      stopViewport2DPan();
      clearActivePointerPan();
      canvas.focus();
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    };

    const updatePinch = (event: TouchEvent) => {
      if (!activePinch || event.touches.length !== 2) return false;
      const distance = getTouchDistance(event.touches);
      if (distance <= 0) return false;
      const rect = canvas.getBoundingClientRect();
      const center = getTouchCenter(event.touches);
      const handled = zoomViewport2DAtCanvasPoint({ x: center.x - rect.left, y: center.y - rect.top }, rect, activePinch.startScaleFactor * (distance / activePinch.startDistance));
      if (!handled) return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (!startPan(event.clientX, event.clientY)) {
        return;
      }
      canvas.focus();
      event.preventDefault();
    };
    const handleMouseMove = (event: MouseEvent) => {
      if (!isViewport2DPanActive()) return;
      updateViewport2DPan(event.clientX, event.clientY);
      event.preventDefault();
    };
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 0 || !isViewport2DPanActive()) return;
      if (!stopViewport2DPan()) return;
      event.preventDefault();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" || !event.isPrimary) return;
      if (event.button !== 0 || !startPan(event.clientX, event.clientY)) {
        return;
      }
      activePointerPanId = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      canvas.focus();
      event.preventDefault();
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (activePointerPanId !== event.pointerId || !isViewport2DPanActive()) {
        return;
      }
      updateViewport2DPan(event.clientX, event.clientY);
      event.preventDefault();
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (activePointerPanId !== event.pointerId) return;
      clearActivePointerPan();
      if (!stopViewport2DPan()) return;
      event.preventDefault();
    };
    const handleTouchStart = (event: TouchEvent) => {
      if (startPinch(event)) return;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch || !startPan(touch.clientX, touch.clientY)) {
        return;
      }
      canvas.focus();
      event.preventDefault();
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (updatePinch(event)) return;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch || !isViewport2DPanActive()) return;
      updateViewport2DPan(touch.clientX, touch.clientY);
      event.preventDefault();
    };
    const handleTouchEnd = (event: TouchEvent) => {
      if (activePinch && event.touches.length < 2) {
        activePinch = null;
        event.preventDefault();
        return;
      }
      if (!isViewport2DPanActive()) return;
      if (!stopViewport2DPan()) return;
      event.preventDefault();
    };
    const handleTouchCancel = (event: TouchEvent) => {
      activePinch = null;
      if (!isViewport2DPanActive()) return;
      if (!stopViewport2DPan()) return;
      event.preventDefault();
    };
    const handleWheel = (event: WheelEvent) => {
      const dominantDelta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (dominantDelta === 0) return;

      const rect = canvas.getBoundingClientRect();
      const { state } = getViewport2DControlsConfig();
      if (!zoomViewport2DAtCanvasPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top }, rect, state.scaleFactor * (dominantDelta < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR))) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerUp);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    canvas.addEventListener("touchstart", handleTouchStart, { passive: false });
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("touchend", handleTouchEnd, { passive: false });
    window.addEventListener("touchcancel", handleTouchCancel, {
      passive: false,
    });
    canvas.addEventListener("wheel", handleWheel, { passive: false });

    this.cleanup2D = () => {
      canvas.removeEventListener("mousedown", handleMouseDown);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerUp);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      canvas.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchCancel);
      canvas.removeEventListener("wheel", handleWheel);
      clearActivePointerPan();
      activePinch = null;
    };
  }

  private setup3DControls(perspectiveCamera: PerspectiveCamera, canvas: HTMLCanvasElement): void {
    const buildPose = (target = this.controlsTarget): ViewportPerspectivePose => ({
      position: {
        x: perspectiveCamera.position.x,
        y: perspectiveCamera.position.y,
        z: perspectiveCamera.position.z,
      },
      up: {
        x: perspectiveCamera.up.x,
        y: perspectiveCamera.up.y,
        z: perspectiveCamera.up.z,
      },
      target: {
        x: target.x,
        y: target.y,
        z: target.z,
      },
    });

    const canUse3DControls = () => this.controlsEnabled && !this.applyingSnapshot;

    const syncCamera = (target = this.controlsTarget) => {
      perspectiveCamera.lookAt(target);
      perspectiveCamera.updateMatrixWorld();
      perspectiveCamera.userData.lpvizLookAtTarget = {
        x: target.x,
        y: target.y,
        z: target.z,
      };
    };

    const emitPose = (target = this.controlsTarget) => {
      this.controlsTarget.copy(target);
      syncCamera(target);
      this.controlsConfig.onChange?.(buildPose(target));
    };

    const orbitOffset = new Vector3();
    const panForward = new Vector3();
    const panBasisRight = new Vector3();
    const panBasisUp = new Vector3();
    const moveDelta = new Vector3();
    const moveTarget = new Vector3();
    let active3DPointerId: number | null = null;
    let activeTwoFingerOrbit = false;
    let activeTwoFingerStartDistance = 0;
    let activeTwoFingerStartCameraDistance = MIN_DISTANCE;

    const getOrbitState = () => {
      const offset = orbitOffset.subVectors(perspectiveCamera.position, this.controlsTarget);
      const distance = Math.max(MIN_DISTANCE, offset.length());
      return {
        distance,
        yaw: Math.atan2(offset.y, offset.x),
        elevation: Math.asin(Math.max(-1, Math.min(1, offset.z / distance))),
      };
    };

    const getPanBasis = (distance: number) => {
      const forward = panForward.subVectors(this.controlsTarget, perspectiveCamera.position).normalize();
      const right = panBasisRight.crossVectors(forward, WORLD_UP);
      if (right.lengthSq() < 1e-8) {
        right.copy(FALLBACK_RIGHT);
      } else {
        right.normalize();
      }
      const up = panBasisUp.crossVectors(right, forward).normalize();
      const fov = (perspectiveCamera.fov * Math.PI) / 180;
      const unitsPerPixel = (2 * Math.tan(fov / 2) * Math.max(MIN_DISTANCE, distance)) / Math.max(1, canvas.clientHeight);
      return { right: right.clone(), up: up.clone(), unitsPerPixel };
    };

    const apply3DMove = (clientX: number, clientY: number) => {
      const drag = this.active3DDrag;
      if (!drag || !canUse3DControls()) return;
      const dx = clientX - drag.startClientX;
      const dy = clientY - drag.startClientY;

      if (drag.kind === "rotate") {
        const yaw = drag.startYaw - dx * ROTATE_RADIANS_PER_PIXEL;
        const elevation = Math.max(MIN_ELEVATION, Math.min(MAX_ELEVATION, drag.startElevation + dy * ROTATE_RADIANS_PER_PIXEL));
        const cosElevation = Math.cos(elevation);
        perspectiveCamera.position.set(
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
      perspectiveCamera.position.copy(drag.startPosition).add(delta);
      emitPose(target);
    };

    const start3DDrag = (kind: Active3DDrag["kind"], clientX: number, clientY: number) => {
      if (!canUse3DControls()) return;
      const orbit = getOrbitState();
      const panBasis = getPanBasis(orbit.distance);
      this.active3DDrag = {
        kind,
        startClientX: clientX,
        startClientY: clientY,
        startTarget: this.controlsTarget.clone(),
        startPosition: perspectiveCamera.position.clone(),
        startDistance: orbit.distance,
        startYaw: orbit.yaw,
        startElevation: orbit.elevation,
        panRight: panBasis.right,
        panUp: panBasis.up,
        unitsPerPixel: panBasis.unitsPerPixel,
      };
      canvas.focus();
      this.controlsConfig.onStart?.();
    };

    const getTouchCenter = (touches: TouchList) => ({
      x: (touches[0]!.clientX + touches[1]!.clientX) / 2,
      y: (touches[0]!.clientY + touches[1]!.clientY) / 2,
    });

    const getTouchDistance = (touches: TouchList) => Math.hypot(touches[1]!.clientX - touches[0]!.clientX, touches[1]!.clientY - touches[0]!.clientY);

    const apply3DZoomDistance = (nextDistance: number) => {
      if (!canUse3DControls()) return;
      const offset = new Vector3().subVectors(perspectiveCamera.position, this.controlsTarget);
      if (offset.lengthSq() <= 1e-8) return;
      perspectiveCamera.position.copy(this.controlsTarget).add(offset.normalize().multiplyScalar(Math.min(this.controlsMaxDistance, Math.max(MIN_DISTANCE, nextDistance))));
      emitPose();
    };

    const stop3DDrag = () => {
      if (!this.active3DDrag) return false;
      this.active3DDrag = null;
      activeTwoFingerOrbit = false;
      activeTwoFingerStartDistance = 0;
      this.controlsConfig.onEnd?.();
      return true;
    };

    const clearActive3DPointer = () => {
      if (active3DPointerId !== null && canvas.hasPointerCapture(active3DPointerId)) {
        canvas.releasePointerCapture(active3DPointerId);
      }
      active3DPointerId = null;
    };

    const handlePointerDown = (event: MouseEvent) => {
      if (event.button !== 0 && event.button !== 2) return;
      start3DDrag(event.button === 0 ? "pan" : "rotate", event.clientX, event.clientY);
      if (!this.active3DDrag) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handlePointerMove = (event: MouseEvent) => {
      if (!this.active3DDrag || !canUse3DControls()) return;
      apply3DMove(event.clientX, event.clientY);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handlePointerUp = (event: MouseEvent) => {
      if (!stop3DDrag()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleTouchStart3D = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      clearActive3DPointer();
      activeTwoFingerStartDistance = getTouchDistance(event.touches);
      if (activeTwoFingerStartDistance <= 0) return;
      activeTwoFingerStartCameraDistance = getOrbitState().distance;
      const center = getTouchCenter(event.touches);
      start3DDrag("rotate", center.x, center.y);
      if (!this.active3DDrag) return;
      activeTwoFingerOrbit = true;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleTouchMove3D = (event: TouchEvent) => {
      if (!activeTwoFingerOrbit || event.touches.length !== 2) return;
      const center = getTouchCenter(event.touches);
      apply3DMove(center.x, center.y);
      const distance = getTouchDistance(event.touches);
      if (distance > 0 && activeTwoFingerStartDistance > 0) {
        apply3DZoomDistance(activeTwoFingerStartCameraDistance * (activeTwoFingerStartDistance / distance));
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleTouchEnd3D = (event: TouchEvent) => {
      if (!activeTwoFingerOrbit || event.touches.length >= 2) return;
      if (!stop3DDrag()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleTouchPointerDown = (event: PointerEvent) => {
      if (activeTwoFingerOrbit) return;
      if (event.pointerType === "mouse" || !event.isPrimary) return;
      if (event.button !== 0) return;
      start3DDrag("pan", event.clientX, event.clientY);
      if (!this.active3DDrag) return;
      active3DPointerId = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleTouchPointerMove = (event: PointerEvent) => {
      if (activeTwoFingerOrbit) return;
      if (active3DPointerId !== event.pointerId || !this.active3DDrag) return;
      apply3DMove(event.clientX, event.clientY);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleTouchPointerUp = (event: PointerEvent) => {
      if (activeTwoFingerOrbit) return;
      if (active3DPointerId !== event.pointerId || !this.active3DDrag) return;
      clearActive3DPointer();
      this.active3DDrag = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.controlsConfig.onEnd?.();
    };

    const handleWheel3D = (event: WheelEvent) => {
      if (!canUse3DControls()) return;
      if (event.shiftKey) return;
      const dominantDelta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (dominantDelta === 0) return;

      const offset = new Vector3().subVectors(perspectiveCamera.position, this.controlsTarget);
      const distance = Math.max(MIN_DISTANCE, offset.length());
      const zoomFactor = Math.pow(1.0015, dominantDelta);
      const nextDistance = Math.min(this.controlsMaxDistance, Math.max(MIN_DISTANCE, distance * zoomFactor));
      if (!Number.isFinite(nextDistance)) return;

      const rect = canvas.getBoundingClientRect();
      const hasCursorAnchor = rect.width > 0 && rect.height > 0 && this.wheelPlaneNormal.subVectors(this.controlsTarget, perspectiveCamera.position).normalize().lengthSq() > 0;
      let anchoredZoom = false;

      if (hasCursorAnchor) {
        this.wheelPointerNdc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
        this.wheelPlane.setFromNormalAndCoplanarPoint(this.wheelPlaneNormal, this.controlsTarget);
        perspectiveCamera.updateMatrixWorld();
        this.wheelRaycaster.setFromCamera(this.wheelPointerNdc, perspectiveCamera);
        anchoredZoom = this.wheelRaycaster.ray.intersectPlane(this.wheelPlane, this.wheelAnchorBefore) !== null;
      }

      perspectiveCamera.position.copy(this.controlsTarget).add(offset.normalize().multiplyScalar(nextDistance));
      if (anchoredZoom) {
        perspectiveCamera.updateMatrixWorld();
        this.wheelRaycaster.setFromCamera(this.wheelPointerNdc, perspectiveCamera);
        if (this.wheelRaycaster.ray.intersectPlane(this.wheelPlane, this.wheelAnchorAfter)) {
          this.wheelDelta.subVectors(this.wheelAnchorBefore, this.wheelAnchorAfter);
          perspectiveCamera.position.add(this.wheelDelta);
          this.controlsTarget.add(this.wheelDelta);
        }
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.controlsConfig.onStart?.();
      emitPose();
      this.controlsConfig.onEnd?.();
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!this.controlsEnabled) return;
      event.preventDefault();
    };

    canvas.addEventListener("mousedown", handlePointerDown);
    canvas.addEventListener("pointerdown", handleTouchPointerDown);
    canvas.addEventListener("pointermove", handleTouchPointerMove);
    canvas.addEventListener("pointerup", handleTouchPointerUp);
    canvas.addEventListener("pointercancel", handleTouchPointerUp);
    canvas.addEventListener("touchstart", handleTouchStart3D, {
      passive: false,
    });
    window.addEventListener("touchmove", handleTouchMove3D, {
      passive: false,
    });
    window.addEventListener("touchend", handleTouchEnd3D, { passive: false });
    window.addEventListener("touchcancel", handleTouchEnd3D, {
      passive: false,
    });
    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
    canvas.addEventListener("wheel", handleWheel3D, { passive: false });
    canvas.addEventListener("contextmenu", handleContextMenu);

    this.cleanup3D = () => {
      canvas.removeEventListener("mousedown", handlePointerDown);
      canvas.removeEventListener("pointerdown", handleTouchPointerDown);
      canvas.removeEventListener("pointermove", handleTouchPointerMove);
      canvas.removeEventListener("pointerup", handleTouchPointerUp);
      canvas.removeEventListener("pointercancel", handleTouchPointerUp);
      canvas.removeEventListener("touchstart", handleTouchStart3D);
      window.removeEventListener("touchmove", handleTouchMove3D);
      window.removeEventListener("touchend", handleTouchEnd3D);
      window.removeEventListener("touchcancel", handleTouchEnd3D);
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
      canvas.removeEventListener("wheel", handleWheel3D);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      this.active3DDrag = null;
      clearActive3DPointer();
      activeTwoFingerOrbit = false;
      activeTwoFingerStartDistance = 0;
    };
  }

  private dispose3DControls(): void {
    this.cleanup3D?.();
    this.cleanup3D = null;
  }

  private applyControlsConfig(): void {
    const perspectiveCamera = this.perspectiveCamera;
    if (!perspectiveCamera) return;

    this.controlsEnabled = this.controlsConfig.enabled && !this.controlsConfig.blocked;
    this.controlsMaxDistance = this.controlsConfig.maxDistance;

    if (this.syncToken === this.controlsConfig.syncToken) {
      return;
    }

    this.syncToken = this.controlsConfig.syncToken;
    this.applyingSnapshot = true;

    const snapshot = this.controlsConfig.snapshot;
    perspectiveCamera.fov = snapshot.perspective.fov;
    perspectiveCamera.aspect = snapshot.perspective.aspect;
    perspectiveCamera.near = snapshot.perspective.near;
    perspectiveCamera.far = snapshot.perspective.far;
    perspectiveCamera.position.set(snapshot.perspective.position.x, snapshot.perspective.position.y, snapshot.perspective.position.z);
    perspectiveCamera.up.set(snapshot.perspective.up.x, snapshot.perspective.up.y, snapshot.perspective.up.z);
    this.controlsTarget.set(snapshot.target.x, snapshot.target.y, snapshot.target.z);
    perspectiveCamera.lookAt(this.controlsTarget);
    perspectiveCamera.updateProjectionMatrix();
    perspectiveCamera.updateMatrixWorld();

    this.applyingSnapshot = false;
    this.sceneManager.invalidate({ layers: false });
  }

  dispose(): void {
    this.unsubscribeConfig();
    this.unsubscribeCameras();
    this.cleanup2D?.();
    this.dispose3DControls();
  }
}
