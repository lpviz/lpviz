import { getViewport2DControlsConfig, isViewport2DPanActive, startViewport2DPan, stopViewport2DPan, updateViewport2DPan, zoomViewport2DAtCanvasPoint } from "@/features/viewport/runtime/controls2d";
import { addListeners, getTouchCenter, getTouchDistance } from "./pointerEvents";

const WHEEL_ZOOM_FACTOR = 1.05;

// The 2D view's pan (mouse, pen, one finger) and zoom (wheel, pinch), driven through the 2D
// controls config so they act only while that config owns the view. Returns the detach.
export function attachPanZoom2D(canvas: HTMLCanvasElement): () => void {
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
