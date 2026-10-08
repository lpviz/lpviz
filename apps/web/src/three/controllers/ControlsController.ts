import { getViewport2DControlsConfig, isViewport2DPanActive, startViewport2DPan, stopViewport2DPan, updateViewport2DPan, zoomViewport2DAtCanvasPoint } from "@/features/viewport/runtime/controls2d";
import { getViewport3DControlsConfig, subscribeViewport3DControlsConfig, type ViewportPerspectivePose } from "@/features/viewport/runtime/controls3d";
import { MIN_PERSPECTIVE_DISTANCE } from "@lpviz/viewport/defaults";
import { configurePerspectiveCameraFromSnapshot } from "@lpviz/viewport/projection3d";
import { Plane, Raycaster, Vector2, Vector3, type PerspectiveCamera } from "three";
import type { SceneManager } from "../SceneManager";
import { xyz } from "./CameraController";

const WHEEL_ZOOM_FACTOR = 1.05;
const ROTATE_RADIANS_PER_PIXEL = 0.008;
const MIN_ELEVATION = 0.08;
const MAX_ELEVATION = Math.PI / 2 - 0.05;
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

type ListenerEntry = {
  [K in keyof GlobalEventHandlersEventMap]: readonly [EventTarget, K, (event: GlobalEventHandlersEventMap[K]) => void, AddEventListenerOptions?];
}[keyof GlobalEventHandlersEventMap];

// Registers the listeners in table order (the 2D set precedes the 3D set on
// the same targets) and returns the matching remover.
function addListeners(entries: readonly ListenerEntry[]): () => void {
  for (const [target, type, handler, options] of entries) target.addEventListener(type, handler as EventListener, options);
  return () => {
    for (const [target, type, handler] of entries) target.removeEventListener(type, handler as EventListener);
  };
}

const getTouchCenter = (touches: TouchList) => ({
  x: (touches[0]!.clientX + touches[1]!.clientX) / 2,
  y: (touches[0]!.clientY + touches[1]!.clientY) / 2,
});

const getTouchDistance = (touches: TouchList) => Math.hypot(touches[1]!.clientX - touches[0]!.clientX, touches[1]!.clientY - touches[0]!.clientY);

export class ControlsController {
  private syncToken = -1;
  private controlsConfig = getViewport3DControlsConfig();
  private unsubscribeConfig: () => void;
  private cleanup2D: () => void;
  private cleanup3D: () => void;
  private controlsTarget = new Vector3();
  private active3DDrag: Active3DDrag | null = null;
  private wheelAnchorAfter = new Vector3();
  private wheelAnchorBefore = new Vector3();
  private wheelDelta = new Vector3();
  private wheelPlane = new Plane();
  private wheelPlaneNormal = new Vector3();
  private wheelPointerNdc = new Vector2();
  private wheelRaycaster = new Raycaster();

  constructor(
    private sceneManager: SceneManager,
    private perspectiveCamera: PerspectiveCamera,
  ) {
    const canvas = sceneManager.renderer.domElement;
    this.cleanup2D = this.setup2DListeners(canvas);

    this.unsubscribeConfig = subscribeViewport3DControlsConfig(() => {
      this.controlsConfig = getViewport3DControlsConfig();
      this.applyControlsConfig();
    });

    this.cleanup3D = this.setup3DControls(canvas);
    this.applyControlsConfig();
  }

  private get controlsEnabled(): boolean {
    return this.controlsConfig.enabled && !this.controlsConfig.blocked;
  }

  private setup2DListeners(canvas: HTMLCanvasElement): () => void {
    let activePointerPanId: number | null = null;
    let activePinch: {
      startDistance: number;
      startScaleFactor: number;
    } | null = null;

    const startPan = (clientX: number, clientY: number) => startViewport2DPan(clientX, clientY, canvas.getBoundingClientRect());

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
    // single-finger touches are handled here as well as through the pointer
    // events above: this touchstart preventDefault is what blocks page scroll
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

    const removeListeners = addListeners([
      [canvas, "mousedown", handleMouseDown],
      [canvas, "pointerdown", handlePointerDown],
      [canvas, "pointermove", handlePointerMove],
      [canvas, "pointerup", handlePointerUp],
      [canvas, "pointercancel", handlePointerUp],
      [window, "mousemove", handleMouseMove],
      [window, "mouseup", handleMouseUp],
      [canvas, "touchstart", handleTouchStart, { passive: false }],
      [window, "touchmove", handleTouchMove, { passive: false }],
      [window, "touchend", handleTouchEnd, { passive: false }],
      [window, "touchcancel", handleTouchCancel, { passive: false }],
      [canvas, "wheel", handleWheel, { passive: false }],
    ]);

    return () => {
      removeListeners();
      clearActivePointerPan();
      activePinch = null;
    };
  }

  private setup3DControls(canvas: HTMLCanvasElement): () => void {
    const perspectiveCamera = this.perspectiveCamera;
    const buildPose = (target = this.controlsTarget): ViewportPerspectivePose => ({
      position: xyz(perspectiveCamera.position),
      up: xyz(perspectiveCamera.up),
      target: xyz(target),
    });

    const syncCamera = (target = this.controlsTarget) => {
      perspectiveCamera.lookAt(target);
      perspectiveCamera.updateMatrixWorld();
      perspectiveCamera.userData.lpvizLookAtTarget = xyz(target);
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
    let activeTwoFingerStartCameraDistance = MIN_PERSPECTIVE_DISTANCE;

    const getOrbitState = () => {
      const offset = orbitOffset.subVectors(perspectiveCamera.position, this.controlsTarget);
      const distance = Math.max(MIN_PERSPECTIVE_DISTANCE, offset.length());
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
      const unitsPerPixel = (2 * Math.tan(fov / 2) * Math.max(MIN_PERSPECTIVE_DISTANCE, distance)) / Math.max(1, canvas.clientHeight);
      return { right: right.clone(), up: up.clone(), unitsPerPixel };
    };

    const apply3DMove = (clientX: number, clientY: number) => {
      const drag = this.active3DDrag;
      if (!drag || !this.controlsEnabled) return;
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
      if (!this.controlsEnabled) return;
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

    const apply3DZoomDistance = (nextDistance: number) => {
      if (!this.controlsEnabled) return;
      const offset = new Vector3().subVectors(perspectiveCamera.position, this.controlsTarget);
      if (offset.lengthSq() <= 1e-8) return;
      perspectiveCamera.position.copy(this.controlsTarget).add(offset.normalize().multiplyScalar(Math.min(this.controlsConfig.maxDistance, Math.max(MIN_PERSPECTIVE_DISTANCE, nextDistance))));
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
      if (!this.active3DDrag || !this.controlsEnabled) return;
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
      stop3DDrag();
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleWheel3D = (event: WheelEvent) => {
      if (!this.controlsEnabled) return;
      if (event.shiftKey) return;
      const dominantDelta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (dominantDelta === 0) return;

      const offset = new Vector3().subVectors(perspectiveCamera.position, this.controlsTarget);
      const distance = Math.max(MIN_PERSPECTIVE_DISTANCE, offset.length());
      const zoomFactor = Math.pow(1.0015, dominantDelta);
      const nextDistance = Math.min(this.controlsConfig.maxDistance, Math.max(MIN_PERSPECTIVE_DISTANCE, distance * zoomFactor));
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

    const removeListeners = addListeners([
      [canvas, "mousedown", handlePointerDown],
      [canvas, "pointerdown", handleTouchPointerDown],
      [canvas, "pointermove", handleTouchPointerMove],
      [canvas, "pointerup", handleTouchPointerUp],
      [canvas, "pointercancel", handleTouchPointerUp],
      [canvas, "touchstart", handleTouchStart3D, { passive: false }],
      [window, "touchmove", handleTouchMove3D, { passive: false }],
      [window, "touchend", handleTouchEnd3D, { passive: false }],
      [window, "touchcancel", handleTouchEnd3D, { passive: false }],
      [window, "mousemove", handlePointerMove],
      [window, "mouseup", handlePointerUp],
      [canvas, "wheel", handleWheel3D, { passive: false }],
      [canvas, "contextmenu", handleContextMenu],
    ]);

    return () => {
      removeListeners();
      this.active3DDrag = null;
      clearActive3DPointer();
      activeTwoFingerOrbit = false;
      activeTwoFingerStartDistance = 0;
    };
  }

  private applyControlsConfig(): void {
    if (this.syncToken === this.controlsConfig.syncToken) {
      return;
    }

    this.syncToken = this.controlsConfig.syncToken;
    // updateMatrixWorld and updateProjectionMatrix read disjoint camera state, so the helper's order is interchangeable with the one used here before
    configurePerspectiveCameraFromSnapshot(this.controlsConfig.snapshot, this.perspectiveCamera, this.controlsTarget);

    this.sceneManager.invalidate({ layers: false });
  }

  dispose(): void {
    this.unsubscribeConfig();
    this.cleanup2D();
    this.cleanup3D();
  }
}
