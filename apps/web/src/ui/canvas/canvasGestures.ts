import { getState } from "@/features/core/store";
import type { EditorTools } from "./editorTools";

const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_RADIUS_PX = 28;

export const swallow = (event: Event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
};

// what the gesture layer drives: the editor's drag lifecycle and its click,
// double-click, context-menu, wheel and keyboard actions (see editorTools.ts)
type CanvasGestureHandlers = Omit<EditorTools, "cleanup">;

type TapState = {
  lastTap: { time: number; clientX: number; clientY: number } | null;
  suppressClickUntil: number;
};

// where a pen or touch gesture began, and whether it has since drifted far
// enough to be a drag rather than a tap
type GestureStart = { clientX: number; clientY: number; moved: boolean };

const markIfMovedBeyondTap = (start: GestureStart, clientX: number, clientY: number) => {
  start.moved = start.moved || Math.hypot(clientX - start.clientX, clientY - start.clientY) > DOUBLE_TAP_RADIUS_PX;
};

// The pointer-type-agnostic bridge from a normalized start/move/release to the
// editor's drag handlers, plus tap and double-tap detection.
function createPointerBridge(canvas: HTMLCanvasElement, handlers: CanvasGestureHandlers, taps: TapState) {
  const handlePointerRelease = (event: Event) => {
    if (getState().isTransitioning3D) return;
    const wasInteracting = getState().editorInteraction.kind !== "idle";
    handlers.handleDragEnd();
    if (wasInteracting) swallow(event);
  };

  const handlePointerStart = (clientX: number, clientY: number, event: Event) => {
    if (getState().isTransitioning3D) return;
    if (handlers.handleDragStart(clientX, clientY)) swallow(event);
  };

  const handlePointerMove = (clientX: number, clientY: number, event: Event) => {
    const state = getState();
    if (state.isTransitioning3D || (state.isNavigatingViewport && state.editorInteraction.kind === "idle")) return;
    handlers.handleDragMove(clientX, clientY);
    if (getState().editorInteraction.kind !== "idle") swallow(event);
  };

  const handleWindowPointerEnd = (event: Event) => {
    if (event.target === canvas) return;
    if (getState().editorInteraction.kind === "idle") return;
    handlePointerRelease(event);
  };

  const registerTap = (clientX: number, clientY: number) => {
    const now = performance.now();
    if (taps.lastTap && now - taps.lastTap.time <= DOUBLE_TAP_MS && Math.hypot(clientX - taps.lastTap.clientX, clientY - taps.lastTap.clientY) <= DOUBLE_TAP_RADIUS_PX) {
      taps.lastTap = null;
      taps.suppressClickUntil = now + DOUBLE_TAP_MS;
      handlers.handleDoubleClickAt(clientX, clientY);
      return true;
    }
    taps.lastTap = { time: now, clientX, clientY };
    return false;
  };

  // The shared tail of a pen pointerup and a touchend: only a gesture that neither drifted nor
  // dragged is tested for a double tap, and the event is swallowed when it was one.
  const endTapGesture = (event: Event, started: GestureStart | null, at: { clientX: number; clientY: number } | undefined) => {
    const wasDragging = getState().editorInteraction.kind === "dragging";
    handlePointerRelease(event);
    if (!at || !started || started.moved || wasDragging) return;
    if (registerTap(at.clientX, at.clientY)) swallow(event);
  };

  return { handlePointerStart, handlePointerMove, handlePointerRelease, handleWindowPointerEnd, endTapGesture };
}

type PointerBridge = ReturnType<typeof createPointerBridge>;

function bindMouse(canvas: HTMLCanvasElement, bridge: PointerBridge, signal: AbortSignal) {
  const capture = { capture: true, signal };
  canvas.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0) return;
      bridge.handlePointerStart(event.clientX, event.clientY, event);
    },
    capture,
  );
  canvas.addEventListener("mousemove", (event) => bridge.handlePointerMove(event.clientX, event.clientY, event), capture);
  canvas.addEventListener(
    "mouseup",
    (event) => {
      if (event.button !== 0) return;
      bridge.handlePointerRelease(event);
    },
    capture,
  );
}

function bindPen(canvas: HTMLCanvasElement, bridge: PointerBridge, signal: AbortSignal) {
  const capture = { capture: true, signal };
  let activePenStart: (GestureStart & { pointerId: number }) | null = null;
  canvas.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "pen" || !event.isPrimary || event.button !== 0) return;
      activePenStart = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, moved: false };
      // Without capture, lifting the pen outside the canvas delivers
      // pointerup elsewhere (and preventDefault suppresses the compat
      // mouseup fallback), leaving the editor stuck in "dragging".
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // pointer may already be gone
      }
      bridge.handlePointerStart(event.clientX, event.clientY, event);
    },
    capture,
  );
  canvas.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "pen" || activePenStart?.pointerId !== event.pointerId) return;
      markIfMovedBeyondTap(activePenStart, event.clientX, event.clientY);
      bridge.handlePointerMove(event.clientX, event.clientY, event);
    },
    capture,
  );
  canvas.addEventListener(
    "pointerup",
    (event) => {
      if (event.pointerType !== "pen" || activePenStart?.pointerId !== event.pointerId) return;
      const started = activePenStart;
      activePenStart = null;
      bridge.endTapGesture(event, started, event);
    },
    capture,
  );
  canvas.addEventListener(
    "pointercancel",
    (event) => {
      if (activePenStart?.pointerId !== event.pointerId) return;
      // end the drag like pointerup would, or the editor stays "dragging"
      // with the viewport controls blocked
      bridge.handlePointerRelease(event);
      activePenStart = null;
    },
    capture,
  );
}

function bindTouch(canvas: HTMLCanvasElement, bridge: PointerBridge, signal: AbortSignal) {
  const capture = { capture: true, passive: false, signal };
  let activeTouchStart: GestureStart | null = null;
  canvas.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      activeTouchStart = { clientX: touch.clientX, clientY: touch.clientY, moved: false };
      bridge.handlePointerStart(touch.clientX, touch.clientY, event);
    },
    capture,
  );
  canvas.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      if (activeTouchStart) markIfMovedBeyondTap(activeTouchStart, touch.clientX, touch.clientY);
      bridge.handlePointerMove(touch.clientX, touch.clientY, event);
    },
    capture,
  );
  canvas.addEventListener(
    "touchend",
    (event) => {
      const started = activeTouchStart;
      activeTouchStart = null;
      bridge.endTapGesture(event, started, event.changedTouches[0]);
    },
    capture,
  );
}

// Registers every listener (mouse, pen, touch, then window release/keyboard,
// then wheel/contextmenu/dblclick/click) and returns the detach.
function attachGestureListeners(canvas: HTMLCanvasElement, handlers: CanvasGestureHandlers, taps: TapState) {
  const listeners = new AbortController();
  const { signal } = listeners;
  const bridge = createPointerBridge(canvas, handlers, taps);

  bindMouse(canvas, bridge, signal);
  bindPen(canvas, bridge, signal);
  bindTouch(canvas, bridge, signal);
  window.addEventListener(
    "mouseup",
    (event) => {
      if (event.button !== 0) return;
      bridge.handleWindowPointerEnd(event);
    },
    { capture: true, signal },
  );
  window.addEventListener("touchend", (event) => bridge.handleWindowPointerEnd(event), { capture: true, passive: false, signal });
  window.addEventListener("keydown", handlers.handleKeyDown, { capture: true, signal });
  canvas.addEventListener("wheel", handlers.handleWheel, { capture: true, passive: false, signal });
  canvas.addEventListener("contextmenu", handlers.handleContextMenu, { capture: true, signal });
  canvas.addEventListener("dblclick", (event) => handlers.handleDoubleClickAt(event.clientX, event.clientY), { signal });
  canvas.addEventListener("click", handlers.handleClick, { signal });

  return () => listeners.abort();
}

// Pointer-gesture normalization for the canvas. Two phases: the tap state is
// created first so the editor's click handler can ask whether a click is the
// synthetic one that follows a double tap; attach() then registers the
// mouse/pen/touch listeners against the editor's handlers.
export function createCanvasGestures(canvas: HTMLCanvasElement) {
  const taps: TapState = { lastTap: null, suppressClickUntil: 0 };
  return {
    isClickSuppressed: () => performance.now() < taps.suppressClickUntil,
    attach: (handlers: CanvasGestureHandlers) => attachGestureListeners(canvas, handlers, taps),
  };
}
