import { getState } from "@/features/core/store";
import { get2DControlsConfig, subscribe2DControlsConfig } from "@/features/viewport/runtime/controls2d";
import type { PointXY } from "@lpviz/math/types";
import { buildViewport2DSnapshot, buildViewport2DStateFromTarget, zoomViewport2DStateAtCanvasPoint } from "@lpviz/viewport/projection2d";
import type { ViewportRect } from "@lpviz/viewport/snapshot";
import { touchPair } from "./touches";

const WHEEL_ZOOM_FACTOR = 1.05;

// The 2D view's pan (any single pointer) and zoom (wheel, pinch). They read the 2D controls
// config, act only while it owns the view, and report every move through it. Returns the detach.
export function attachPanZoom2D(canvas: HTMLCanvasElement): () => void {
  // the view at the start of a pan, which each move offsets from
  let activePan: { startClientX: number; startClientY: number; targetX: number; targetY: number; scaleFactor: number; gridSpacing: number } | null = null;
  let panPointerId: number | null = null;
  // the fingers on the canvas; two of them pinch
  const touches = new Map<number, PointXY>();
  let activePinch: { startDistance: number; startScaleFactor: number } | null = null;

  const canZoom = () => {
    const config = get2DControlsConfig();
    return config.enabled && !config.blocked;
  };
  const canPan = () => canZoom() && get2DControlsConfig().panEnabled && getState().editorInteraction.kind === "idle";
  // a pan in progress ends the moment the controls lose the view
  const subscriptions = new AbortController();
  subscribe2DControlsConfig(() => {
    const config = get2DControlsConfig();
    if (!config.enabled || config.blocked || !config.panEnabled) activePan = null;
  }, subscriptions.signal);

  const startPan = (clientX: number, clientY: number) => {
    if (!canPan()) return false;
    const config = get2DControlsConfig();
    const snapshot = buildViewport2DSnapshot(config.state, config.sidebarWidth, canvas.getBoundingClientRect(), config.fallbackSnapshot);
    activePan = { startClientX: clientX, startClientY: clientY, targetX: snapshot.target.x, targetY: snapshot.target.y, scaleFactor: config.state.scaleFactor, gridSpacing: config.state.gridSpacing };
    return true;
  };
  const panActive = () => activePan !== null && get2DControlsConfig().enabled;
  const updatePan = (clientX: number, clientY: number) => {
    const config = get2DControlsConfig();
    if (!activePan || !config.enabled) return;
    const unitsPerPixel = 1 / (activePan.gridSpacing * activePan.scaleFactor);
    const target = { x: activePan.targetX - (clientX - activePan.startClientX) * unitsPerPixel, y: activePan.targetY + (clientY - activePan.startClientY) * unitsPerPixel };
    config.onStateChange?.(buildViewport2DStateFromTarget(target, activePan.scaleFactor, activePan.gridSpacing, config.sidebarWidth));
    config.onNavigationFrame?.();
  };
  const stopPan = () => {
    if (!activePan) return false;
    activePan = null;
    panPointerId = null;
    return true;
  };
  const zoomAt = (point: PointXY, rect: ViewportRect, scaleFactor: number) => {
    if (!canZoom()) return false;
    const config = get2DControlsConfig();
    config.onStateChange?.(zoomViewport2DStateAtCanvasPoint(config.state, config.sidebarWidth, rect, config.fallbackSnapshot, point, scaleFactor));
    config.onNavigationFrame?.();
    return true;
  };

  // a second finger turns the gesture into a pinch; the pan it interrupts ends
  const startPinch = () => {
    const { distance } = touchPair(touches);
    if (distance <= 0 || !canZoom()) return false;
    activePinch = { startDistance: distance, startScaleFactor: get2DControlsConfig().state.scaleFactor };
    stopPan();
    canvas.focus();
    return true;
  };
  const updatePinch = () => {
    if (!activePinch || touches.size !== 2) return false;
    const { center, distance } = touchPair(touches);
    if (distance <= 0) return false;
    const rect = canvas.getBoundingClientRect();
    return zoomAt({ x: center.x - rect.left, y: center.y - rect.top }, rect, activePinch.startScaleFactor * (distance / activePinch.startDistance));
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
      if (touches.size === 2) {
        if (startPinch()) event.preventDefault();
        return;
      }
      if (touches.size > 2) return;
    }
    if (event.button !== 0 || !event.isPrimary || !startPan(event.clientX, event.clientY)) return;
    panPointerId = event.pointerId;
    // with the pointer captured, the pan follows it outside the canvas
    canvas.setPointerCapture(event.pointerId);
    canvas.focus();
    event.preventDefault();
  };
  const handlePointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch" && touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (activePinch) {
        if (updatePinch()) event.preventDefault();
        return;
      }
    }
    if (panPointerId !== event.pointerId || !panActive()) return;
    updatePan(event.clientX, event.clientY);
    event.preventDefault();
  };
  const handlePointerUp = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      touches.delete(event.pointerId);
      if (activePinch) {
        activePinch = null;
        event.preventDefault();
        return;
      }
    }
    if (panPointerId !== event.pointerId) return;
    if (stopPan()) event.preventDefault();
  };
  const handleWheel = (event: WheelEvent) => {
    const dominantDelta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (dominantDelta === 0) return;

    const rect = canvas.getBoundingClientRect();
    const { state } = get2DControlsConfig();
    if (!zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, rect, state.scaleFactor * (dominantDelta < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const listeners = new AbortController();
  const { signal } = listeners;
  canvas.addEventListener("pointerdown", handlePointerDown, { signal });
  canvas.addEventListener("pointermove", handlePointerMove, { signal });
  canvas.addEventListener("pointerup", handlePointerUp, { signal });
  canvas.addEventListener("pointercancel", handlePointerUp, { signal });
  canvas.addEventListener("wheel", handleWheel, { passive: false, signal });

  return () => {
    subscriptions.abort();
    listeners.abort();
    activePan = null;
    activePinch = null;
    touches.clear();
  };
}
