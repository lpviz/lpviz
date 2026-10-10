import { getState } from "@/features/core/store";
import { get2DControlsConfig, subscribe2DControlsConfig } from "@/features/viewport/runtime/controls2d";
import type { PointXY } from "@lpviz/math/types";
import { buildViewport2DSnapshot, buildViewport2DStateFromTarget, zoomViewport2DStateAtCanvasPoint } from "@lpviz/viewport/projection2d";
import type { ViewportRect } from "@lpviz/viewport/snapshot";
import { addListeners, getTouchCenter, getTouchDistance } from "./controlEvents";

const WHEEL_ZOOM_FACTOR = 1.05;

// The 2D view's pan (mouse, pen, one finger) and zoom (wheel, pinch). They read the 2D controls
// config, act only while it owns the view, and report every move through it. Returns the detach.
export function attachPanZoom2D(canvas: HTMLCanvasElement): () => void {
  // the view at the start of a pan, which each move offsets from
  let activePan: { startClientX: number; startClientY: number; targetX: number; targetY: number; scaleFactor: number; gridSpacing: number } | null = null;
  let activePointerPanId: number | null = null;
  let activePinch: {
    startDistance: number;
    startScaleFactor: number;
  } | null = null;

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
    return true;
  };
  const zoomAt = (point: PointXY, rect: ViewportRect, scaleFactor: number) => {
    if (!canZoom()) return false;
    const config = get2DControlsConfig();
    config.onStateChange?.(zoomViewport2DStateAtCanvasPoint(config.state, config.sidebarWidth, rect, config.fallbackSnapshot, point, scaleFactor));
    config.onNavigationFrame?.();
    return true;
  };

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
    const config = get2DControlsConfig();
    if (!config.enabled || config.blocked) return false;
    activePinch = {
      startDistance,
      startScaleFactor: config.state.scaleFactor,
    };
    stopPan();
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
    const handled = zoomAt({ x: center.x - rect.left, y: center.y - rect.top }, rect, activePinch.startScaleFactor * (distance / activePinch.startDistance));
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
    if (!panActive()) return;
    updatePan(event.clientX, event.clientY);
    event.preventDefault();
  };
  const handleMouseUp = (event: MouseEvent) => {
    if (event.button !== 0 || !panActive()) return;
    if (!stopPan()) return;
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
    if (activePointerPanId !== event.pointerId || !panActive()) {
      return;
    }
    updatePan(event.clientX, event.clientY);
    event.preventDefault();
  };
  const handlePointerUp = (event: PointerEvent) => {
    if (activePointerPanId !== event.pointerId) return;
    clearActivePointerPan();
    if (!stopPan()) return;
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
    if (!touch || !panActive()) return;
    updatePan(touch.clientX, touch.clientY);
    event.preventDefault();
  };
  const handleTouchEnd = (event: TouchEvent) => {
    if (activePinch && event.touches.length < 2) {
      activePinch = null;
      event.preventDefault();
      return;
    }
    if (!panActive()) return;
    if (!stopPan()) return;
    event.preventDefault();
  };
  const handleTouchCancel = (event: TouchEvent) => {
    activePinch = null;
    if (!panActive()) return;
    if (!stopPan()) return;
    event.preventDefault();
  };
  const handleWheel = (event: WheelEvent) => {
    const dominantDelta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (dominantDelta === 0) return;

    const rect = canvas.getBoundingClientRect();
    const { state } = get2DControlsConfig();
    if (!zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, rect, state.scaleFactor * (dominantDelta < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR))) {
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
    subscriptions.abort();
    removeListeners();
    clearActivePointerPan();
    activePinch = null;
  };
}
