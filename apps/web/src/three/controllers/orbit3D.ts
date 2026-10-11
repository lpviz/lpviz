import { get3DControlsConfig, subscribe3DControlsConfig } from "@/features/viewport/runtime/channels";
import { MIN_PERSPECTIVE_DISTANCE } from "@lpviz/viewport/defaults";
import { unitsPerPixelAtDistance } from "@lpviz/viewport/perspective";
import { configurePerspectiveCameraFromSnapshot, zoomPerspectivePoseAtCanvasPoint } from "@lpviz/viewport/projection3d";
import type { ViewportPerspectivePose } from "@lpviz/viewport/snapshot";
import { Vector3, type PerspectiveCamera } from "three";
import type { SceneManager } from "../SceneManager";
import { attachPointerGestures } from "./pointerGestures";

const ROTATE_RADIANS_PER_PIXEL = 0.008;
const MIN_ELEVATION = 0.08;
const MAX_ELEVATION = Math.PI / 2 - 0.05;
const WHEEL_ZOOM_BASE = 1.0015;
const WORLD_UP = new Vector3(0, 0, 1);
const FALLBACK_RIGHT = new Vector3(1, 0, 0);

// a plain {x, y, z} copy, as the viewport runtime's pose type wants
const xyz = ({ x, y, z }: { x: number; y: number; z: number }) => ({ x, y, z });

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

// The 3D view's orbit controls: a left-button or one-finger drag pans in the target plane, a
// right-button or two-finger drag orbits, the wheel (or a pinch) zooms toward the cursor. They
// move the perspective camera and its target directly and report each pose through the 3D
// controls config, which also tells them when they own the view and re-poses the camera from a
// snapshot when asked. Returns the detach.
export function attachOrbit3D(sceneManager: SceneManager, camera: PerspectiveCamera, /** the point the camera looks at, shared with the camera controller */ target: Vector3): () => void {
  const canvas = sceneManager.renderer.domElement;
  let config = get3DControlsConfig();
  let syncToken = -1;
  let activeDrag: ActiveDrag | null = null;
  // two fingers orbit and pinch at once
  let twoFinger: { startDistance: number; startCameraDistance: number } | null = null;

  const enabled = () => config.enabled && !config.blocked;
  const clampDistance = (distance: number) => Math.min(config.maxDistance, Math.max(MIN_PERSPECTIVE_DISTANCE, distance));

  const orbitOffset = new Vector3();
  const panForward = new Vector3();
  const panBasisRight = new Vector3();
  const panBasisUp = new Vector3();
  const moveDelta = new Vector3();
  const moveTarget = new Vector3();
  const zoomOffset = new Vector3();

  const pose = (at: Vector3): ViewportPerspectivePose => ({ position: xyz(camera.position), up: xyz(camera.up), target: xyz(at) });

  const emitPose = (at = target) => {
    target.copy(at);
    camera.lookAt(at);
    camera.updateMatrixWorld();
    config.onChange?.(pose(at));
  };

  const getOrbitState = () => {
    const offset = orbitOffset.subVectors(camera.position, target);
    const distance = Math.max(MIN_PERSPECTIVE_DISTANCE, offset.length());
    return {
      distance,
      yaw: Math.atan2(offset.y, offset.x),
      elevation: Math.asin(Math.max(-1, Math.min(1, offset.z / distance))),
    };
  };

  const getPanBasis = (distance: number) => {
    const forward = panForward.subVectors(target, camera.position).normalize();
    const right = panBasisRight.crossVectors(forward, WORLD_UP);
    if (right.lengthSq() < 1e-8) {
      right.copy(FALLBACK_RIGHT);
    } else {
      right.normalize();
    }
    const up = panBasisUp.crossVectors(right, forward).normalize();
    return { right: right.clone(), up: up.clone(), unitsPerPixel: unitsPerPixelAtDistance(config.snapshot, distance, canvas.clientHeight) };
  };

  const applyMove = (clientX: number, clientY: number) => {
    const drag = activeDrag;
    if (!drag || !enabled()) return;
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
    const next = moveTarget.copy(drag.startTarget).add(delta);
    camera.position.copy(drag.startPosition).add(delta);
    emitPose(next);
  };

  const startDrag = (kind: ActiveDrag["kind"], clientX: number, clientY: number) => {
    if (!enabled()) return;
    const orbit = getOrbitState();
    const panBasis = getPanBasis(orbit.distance);
    activeDrag = {
      kind,
      startClientX: clientX,
      startClientY: clientY,
      startTarget: target.clone(),
      startPosition: camera.position.clone(),
      startDistance: orbit.distance,
      startYaw: orbit.yaw,
      startElevation: orbit.elevation,
      panRight: panBasis.right,
      panUp: panBasis.up,
      unitsPerPixel: panBasis.unitsPerPixel,
    };
    canvas.focus();
    config.onStart?.();
  };

  const applyZoomDistance = (nextDistance: number) => {
    if (!enabled()) return;
    const offset = zoomOffset.subVectors(camera.position, target);
    if (offset.lengthSq() <= 1e-8) return;
    camera.position.copy(target).add(offset.normalize().multiplyScalar(clampDistance(nextDistance)));
    emitPose();
  };

  const stopDrag = () => {
    if (!activeDrag) return false;
    activeDrag = null;
    twoFinger = null;
    config.onEnd?.();
    return true;
  };

  // the wheel zooms toward the cursor: the world point under it in the target plane stays put
  const wheelZoom = (event: WheelEvent, dominantDelta: number) => {
    if (!enabled() || event.shiftKey) return false;

    const nextDistance = clampDistance(getOrbitState().distance * Math.pow(WHEEL_ZOOM_BASE, dominantDelta));
    if (!Number.isFinite(nextDistance)) return false;

    const rect = canvas.getBoundingClientRect();
    const next = zoomPerspectivePoseAtCanvasPoint(config.snapshot, pose(target), rect, { x: event.clientX - rect.left, y: event.clientY - rect.top }, nextDistance);
    camera.position.set(next.position.x, next.position.y, next.position.z);
    config.onStart?.();
    emitPose(moveTarget.set(next.target.x, next.target.y, next.target.z));
    config.onEnd?.();
    return true;
  };

  const handleContextMenu = (event: MouseEvent) => {
    if (!enabled()) return;
    event.preventDefault();
  };

  // Re-pose the camera from the config's snapshot when the runtime asks (a bumped sync token).
  const applyConfig = () => {
    if (syncToken === config.syncToken) return;
    syncToken = config.syncToken;
    configurePerspectiveCameraFromSnapshot(config.snapshot, camera, target);
    sceneManager.invalidate("frame");
  };

  const subscriptions = new AbortController();
  subscribe3DControlsConfig(() => {
    config = get3DControlsConfig();
    applyConfig();
  }, subscriptions.signal);
  const detach = attachPointerGestures(canvas, {
    // the left button or one finger pans, the right button orbits
    dragStart: (event) => {
      const kind = event.button === 0 ? "pan" : event.button === 2 && event.pointerType === "mouse" ? "rotate" : null;
      if (!kind) return false;
      startDrag(kind, event.clientX, event.clientY);
      return activeDrag !== null;
    },
    dragMove: applyMove,
    dragEnd: stopDrag,
    // a second finger turns the gesture into an orbit that also zooms by the pinch, in place of
    // the one-finger pan
    pinchStart: ({ center, distance }) => {
      if (distance <= 0) return false;
      const startCameraDistance = getOrbitState().distance;
      startDrag("rotate", center.x, center.y);
      if (!activeDrag) return false;
      twoFinger = { startDistance: distance, startCameraDistance };
      return true;
    },
    pinchMove: ({ center, distance }) => {
      if (!twoFinger) return;
      applyMove(center.x, center.y);
      if (distance > 0) applyZoomDistance(twoFinger.startCameraDistance * (twoFinger.startDistance / distance));
    },
    pinchEnd: () => {
      stopDrag();
    },
    wheel: wheelZoom,
  });
  canvas.addEventListener("contextmenu", handleContextMenu, { signal: subscriptions.signal });
  applyConfig();

  return () => {
    subscriptions.abort();
    detach();
    activeDrag = null;
    twoFinger = null;
  };
}
