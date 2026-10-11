import { dominantWheelDelta, swallow } from "@/ui/dom";
import type { PointXY } from "@lpviz/math/types";

type TouchPair = { center: PointXY; distance: number };

// What a viewport controller does with the gestures the canvas receives. A handler returns
// whether it took the gesture; a taken pointer gesture loses its default action, a taken wheel
// also stops at this listener.
export type PointerGestureHandlers = {
  /** one pointer pressed (the handler reads the button); true claims it as a drag */
  dragStart: (event: PointerEvent) => boolean;
  dragMove: (clientX: number, clientY: number) => void;
  /** the dragging pointer lifted or was cancelled; true when a drag was in progress */
  dragEnd: () => boolean;
  /** a second finger landed; true claims the pair (the drag the first finger began is the handler's to end) */
  pinchStart: (pair: TouchPair) => boolean;
  pinchMove: (pair: TouchPair) => void;
  /** either finger lifted */
  pinchEnd: () => void;
  /** the wheel's dominant-axis delta, never zero; true consumes the event */
  wheel: (event: WheelEvent, dominantDelta: number) => boolean;
};

/** The midpoint and the distance of the first two touches, in the order they landed. */
function touchPair(touches: ReadonlyMap<number, PointXY>): TouchPair {
  const [a, b] = touches.values();
  if (!a || !b) return { center: a ?? { x: 0, y: 0 }, distance: 0 };
  return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(b.x - a.x, b.y - a.y) };
}

// The pointer scaffolding under both viewport controllers: the fingers on the canvas (two of
// them pinch, a third is ignored), the one dragging pointer, pointer capture so a drag follows
// the pointer outside the canvas, and the wheel's dominant axis. Returns the detach.
export function attachPointerGestures(canvas: HTMLCanvasElement, handlers: PointerGestureHandlers): () => void {
  const touches = new Map<number, PointXY>();
  let dragPointerId: number | null = null;
  let pinching = false;

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
      if (touches.size === 2) {
        // the pair is the gesture now, whatever the first finger was doing
        if (!handlers.pinchStart(touchPair(touches))) return;
        pinching = true;
        dragPointerId = null;
        canvas.focus();
        event.preventDefault();
        return;
      }
      if (touches.size > 2) return;
    }
    if (pinching || !event.isPrimary || !handlers.dragStart(event)) return;
    dragPointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    canvas.focus();
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch" && touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinching) {
        if (touches.size === 2) handlers.pinchMove(touchPair(touches));
        event.preventDefault();
        return;
      }
    }
    if (dragPointerId !== event.pointerId) return;
    handlers.dragMove(event.clientX, event.clientY);
    event.preventDefault();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      touches.delete(event.pointerId);
      if (pinching) {
        pinching = false;
        handlers.pinchEnd();
        event.preventDefault();
        return;
      }
    }
    if (dragPointerId !== event.pointerId) return;
    dragPointerId = null;
    if (handlers.dragEnd()) event.preventDefault();
  };

  const onWheel = (event: WheelEvent) => {
    const dominantDelta = dominantWheelDelta(event);
    if (dominantDelta !== 0 && handlers.wheel(event, dominantDelta)) swallow(event);
  };

  const listeners = new AbortController();
  const { signal } = listeners;
  canvas.addEventListener("pointerdown", onPointerDown, { signal });
  canvas.addEventListener("pointermove", onPointerMove, { signal });
  canvas.addEventListener("pointerup", onPointerUp, { signal });
  canvas.addEventListener("pointercancel", onPointerUp, { signal });
  canvas.addEventListener("wheel", onWheel, { passive: false, signal });

  return () => {
    listeners.abort();
    touches.clear();
  };
}
