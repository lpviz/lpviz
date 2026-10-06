import { getState } from "@/features/core/store";

const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_RADIUS_PX = 28;

export const swallow = (event: Event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
};

// what the gesture layer drives: the editor's drag lifecycle and its click,
// double-click, context-menu, wheel and keyboard actions
type CanvasGestureHandlers = {
  handleDragStart: (clientX: number, clientY: number) => boolean;
  handleDragMove: (clientX: number, clientY: number) => void;
  handleDragEnd: () => void;
  handleClick: (event: MouseEvent) => void;
  handleDoubleClickAt: (clientX: number, clientY: number) => void;
  handleContextMenu: (event: MouseEvent) => void;
  handleWheel: (event: WheelEvent) => void;
  handleKeyDown: (event: KeyboardEvent) => void;
};

type TapState = {
  lastTap: {
    time: number;
    clientX: number;
    clientY: number;
  } | null;
  suppressClickUntil: number;
};

type GestureStart = { clientX: number; clientY: number; moved: boolean };

type BindEvent = (target: EventTarget, eventName: string, handler: (event: never) => void, options?: boolean | AddEventListenerOptions) => void;

// pen and touch share the same "has this gesture drifted far enough to be a
// drag rather than a tap" test, latched onto the gesture's start record
const markIfMovedBeyondTap = (start: GestureStart, clientX: number, clientY: number) => {
  start.moved = start.moved || Math.hypot(clientX - start.clientX, clientY - start.clientY) > DOUBLE_TAP_RADIUS_PX;
};

// The pointer-type-agnostic bridge from a normalized start/move/release to the
// editor's drag handlers, plus tap and double-tap detection.
function createPointerBridge(canvas: HTMLCanvasElement, handlers: CanvasGestureHandlers, taps: TapState) {
  const handlePointerRelease = (event: MouseEvent | TouchEvent | PointerEvent) => {
    if (getState().isTransitioning3D) return;

    const interactionBeforeEnd = getState();
    handlers.handleDragEnd();
    if (interactionBeforeEnd.editorInteraction.kind !== "idle") swallow(event);
  };

  const stopBlockedPointerEvent = (event: MouseEvent | TouchEvent | PointerEvent) => {
    if (getState().editorInteraction.kind !== "idle") swallow(event);
  };

  const handlePointerStart = (clientX: number, clientY: number, event: MouseEvent | TouchEvent | PointerEvent) => {
    if (getState().isTransitioning3D) return;
    if (handlers.handleDragStart(clientX, clientY)) swallow(event);
  };

  const handlePointerMove = (clientX: number, clientY: number, event: MouseEvent | TouchEvent | PointerEvent) => {
    const state = getState();
    if (state.isTransitioning3D || (state.isNavigatingViewport && state.editorInteraction.kind === "idle")) {
      return;
    }
    handlers.handleDragMove(clientX, clientY);
    stopBlockedPointerEvent(event);
  };

  const handleWindowPointerEnd = (event: MouseEvent | TouchEvent | PointerEvent) => {
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
  const endTapGesture = (event: PointerEvent | TouchEvent, started: { moved: boolean } | null, forget: () => void, at: { clientX: number; clientY: number } | undefined) => {
    const interactionBeforeEnd = getState().editorInteraction;
    handlePointerRelease(event);
    forget();
    if (!at || !started || started.moved || interactionBeforeEnd.kind === "dragging") return;
    if (registerTap(at.clientX, at.clientY)) swallow(event);
  };

  return { handlePointerStart, handlePointerMove, handlePointerRelease, handleWindowPointerEnd, endTapGesture };
}

type PointerBridge = ReturnType<typeof createPointerBridge>;

function bindMouseListeners(bindEvent: BindEvent, canvas: HTMLCanvasElement, bridge: PointerBridge) {
  bindEvent(
    canvas,
    "mousedown",
    (event: MouseEvent) => {
      if (event.button !== 0) return;
      bridge.handlePointerStart(event.clientX, event.clientY, event);
    },
    { capture: true },
  );
  bindEvent(
    canvas,
    "mousemove",
    (event: MouseEvent) => {
      bridge.handlePointerMove(event.clientX, event.clientY, event);
    },
    { capture: true },
  );
  bindEvent(
    canvas,
    "mouseup",
    (event: MouseEvent) => {
      if (event.button !== 0) return;
      bridge.handlePointerRelease(event);
    },
    { capture: true },
  );
}

function bindPenListeners(bindEvent: BindEvent, canvas: HTMLCanvasElement, bridge: PointerBridge) {
  let activePenStart: {
    pointerId: number;
    clientX: number;
    clientY: number;
    moved: boolean;
  } | null = null;
  bindEvent(
    canvas,
    "pointerdown",
    (event: PointerEvent) => {
      if (event.pointerType !== "pen" || !event.isPrimary || event.button !== 0) {
        return;
      }
      activePenStart = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        moved: false,
      };
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
    { capture: true },
  );
  bindEvent(
    canvas,
    "pointermove",
    (event: PointerEvent) => {
      if (event.pointerType !== "pen" || !activePenStart || activePenStart.pointerId !== event.pointerId) {
        return;
      }
      markIfMovedBeyondTap(activePenStart, event.clientX, event.clientY);
      bridge.handlePointerMove(event.clientX, event.clientY, event);
    },
    { capture: true },
  );
  bindEvent(
    canvas,
    "pointerup",
    (event: PointerEvent) => {
      if (event.pointerType !== "pen" || !activePenStart || activePenStart.pointerId !== event.pointerId) {
        return;
      }
      bridge.endTapGesture(event, activePenStart, () => (activePenStart = null), event);
    },
    { capture: true },
  );
  bindEvent(
    canvas,
    "pointercancel",
    (event: PointerEvent) => {
      if (activePenStart?.pointerId === event.pointerId) {
        // end the drag like pointerup would, or the editor stays "dragging"
        // with the viewport controls blocked
        bridge.handlePointerRelease(event);
        activePenStart = null;
      }
    },
    { capture: true },
  );
}

function bindTouchListeners(bindEvent: BindEvent, canvas: HTMLCanvasElement, bridge: PointerBridge) {
  let activeTouchStart: {
    clientX: number;
    clientY: number;
    moved: boolean;
  } | null = null;
  bindEvent(
    canvas,
    "touchstart",
    (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      activeTouchStart = {
        clientX: touch.clientX,
        clientY: touch.clientY,
        moved: false,
      };
      bridge.handlePointerStart(touch.clientX, touch.clientY, event);
    },
    { passive: false, capture: true },
  );
  bindEvent(
    canvas,
    "touchmove",
    (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      if (activeTouchStart) {
        markIfMovedBeyondTap(activeTouchStart, touch.clientX, touch.clientY);
      }
      bridge.handlePointerMove(touch.clientX, touch.clientY, event);
    },
    { passive: false, capture: true },
  );
  bindEvent(
    canvas,
    "touchend",
    (event: TouchEvent) => {
      bridge.endTapGesture(event, activeTouchStart, () => (activeTouchStart = null), event.changedTouches[0]);
    },
    { passive: false, capture: true },
  );
}

// Registers every listener (mouse, pen, touch, then window release/keyboard,
// then wheel/contextmenu/dblclick/click) and returns the detach.
function attachGestureListeners(canvas: HTMLCanvasElement, handlers: CanvasGestureHandlers, taps: TapState) {
  const cleanupHandlers: Array<() => void> = [];

  const bindEvent: BindEvent = (target, eventName, handler, options) => {
    const listener = handler as EventListener;
    target.addEventListener(eventName, listener, options);
    cleanupHandlers.push(() => target.removeEventListener(eventName, listener, options));
  };

  const bridge = createPointerBridge(canvas, handlers, taps);

  bindMouseListeners(bindEvent, canvas, bridge);
  bindPenListeners(bindEvent, canvas, bridge);
  bindTouchListeners(bindEvent, canvas, bridge);
  bindEvent(
    window,
    "mouseup",
    (event: MouseEvent) => {
      if (event.button !== 0) return;
      bridge.handleWindowPointerEnd(event);
    },
    { capture: true },
  );
  bindEvent(window, "touchend", (event: TouchEvent) => bridge.handleWindowPointerEnd(event), { passive: false, capture: true });
  bindEvent(window, "keydown", handlers.handleKeyDown, { capture: true });
  bindEvent(canvas, "wheel", handlers.handleWheel, { passive: false, capture: true });
  bindEvent(canvas, "contextmenu", handlers.handleContextMenu, { capture: true });
  bindEvent(canvas, "dblclick", (event: MouseEvent) => handlers.handleDoubleClickAt(event.clientX, event.clientY));
  bindEvent(canvas, "click", handlers.handleClick);

  return () => {
    while (cleanupHandlers.length > 0) cleanupHandlers.pop()?.();
  };
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
