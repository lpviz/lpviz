import { getState } from "@/features/core/store";
import { swallow } from "@/ui/dom";
import type { EditorTools } from "./editorTools";

const DOUBLE_TAP_MS = 350;
// a finger held this long without drifting is a press-and-hold, the touch form of a right-click
const LONG_PRESS_MS = 500;
// how far a finger may wander and still be a tap; a mouse or a pen is held steadier
const TOUCH_TAP_SLOP_PX = 28;
const POINTER_TAP_SLOP_PX = 5;

type PointerTools = Omit<EditorTools, "cleanup">;

// The primary pointer's press: where it began, whether it has since drifted beyond a tap, and
// whether a press-and-hold has already acted on it.
type Press = { pointerId: number; pointerType: string; clientX: number; clientY: number; moved: boolean; held: boolean };

// What a click after a press means: the browser's click follows every press, so a press that
// drifted (a drag or a pan) or that completed a double tap must not also count as a click.
type ClickState = {
  lastTap: { time: number; clientX: number; clientY: number } | null;
  suppressClickUntil: number;
  lastPressMoved: boolean;
};

// The editor behind the transition guard: while the view animates between 2D and 3D nothing is
// editable, so every handler is a no-op (a press is not claimed, no tap or edit lands).
const unlessTransitioning =
  <A extends unknown[], R>(fn: (...args: A) => R) =>
  (...args: A): R | undefined =>
    getState().isTransitioning3D ? undefined : fn(...args);
const guarded = (tools: PointerTools) => ({
  handleDragStart: unlessTransitioning(tools.handleDragStart),
  handleDragMove: unlessTransitioning(tools.handleDragMove),
  handleDragEnd: unlessTransitioning(tools.handleDragEnd),
  handleClick: unlessTransitioning(tools.handleClick),
  handleDoubleClickAt: unlessTransitioning(tools.handleDoubleClickAt),
  handleContextMenu: unlessTransitioning(tools.handleContextMenu),
});

// The editor's drag handlers behind the store's navigation guard, plus the tap and double-tap
// detection for touch and pen (a mouse gets the browser's dblclick instead).
function createPointerBridge(editor: ReturnType<typeof guarded>, clicks: ClickState) {
  const release = (event: Event) => {
    const wasInteracting = getState().editorInteraction.kind !== "idle";
    editor.handleDragEnd();
    if (wasInteracting) swallow(event);
  };

  const start = (event: PointerEvent) => {
    if (editor.handleDragStart(event.clientX, event.clientY)) swallow(event);
  };

  const move = (event: PointerEvent) => {
    const state = getState();
    if (state.isNavigatingViewport && state.editorInteraction.kind === "idle") return;
    editor.handleDragMove(event.clientX, event.clientY);
    if (getState().editorInteraction.kind !== "idle") swallow(event);
  };

  // A press-and-hold does what a right-click does: deletes the vertex or resets the start ring
  // under it. A press that acted is spent: the drag it may have started ends here, so the finger
  // moving on does not drag whatever now sits at the deleted vertex's index. A hold that found
  // nothing leaves its drag alone, since a finger often pauses before it moves.
  const hold = (event: PointerEvent) => {
    if (editor.handleContextMenu(event)) release(event);
  };

  const registerTap = (clientX: number, clientY: number) => {
    const now = performance.now();
    const last = clicks.lastTap;
    if (last && now - last.time <= DOUBLE_TAP_MS && Math.hypot(clientX - last.clientX, clientY - last.clientY) <= TOUCH_TAP_SLOP_PX) {
      clicks.lastTap = null;
      clicks.suppressClickUntil = now + DOUBLE_TAP_MS;
      editor.handleDoubleClickAt(clientX, clientY);
      return true;
    }
    clicks.lastTap = { time: now, clientX, clientY };
    return false;
  };

  // The end of a press: only a touch or pen press that neither drifted, dragged nor held is a
  // tap, and a second tap in quick succession is a double tap. A touch has no browser click (its
  // touch events are cancelled, see attachCanvasGestures), so a single touch tap is clicked here;
  // a pen's browser click follows and is suppressed when the tap completed a double tap.
  const end = (event: PointerEvent, press: Press) => {
    const wasDragging = getState().editorInteraction.kind === "dragging";
    release(event);
    if (press.pointerType === "mouse" || press.moved || press.held || wasDragging) return;
    const doubled = registerTap(event.clientX, event.clientY);
    if (press.pointerType === "touch") {
      if (!doubled) editor.handleClick(event);
      return;
    }
    if (doubled) swallow(event);
  };

  return { start, move, hold, release, end };
}

// Pointer-gesture normalization for the canvas: registers every listener (the press, then the
// context menu, double-click and click) against the editor's handlers and returns the detach.
export function attachCanvasGestures(canvas: HTMLCanvasElement, tools: PointerTools): () => void {
  const clicks: ClickState = { lastTap: null, suppressClickUntil: 0, lastPressMoved: false };
  const isClickSuppressed = () => clicks.lastPressMoved || performance.now() < clicks.suppressClickUntil;
  const editor = guarded(tools);
  const bridge = createPointerBridge(editor, clicks);
  const listeners = new AbortController();
  const { signal } = listeners;
  const capture = { capture: true, signal };
  let press: Press | null = null;
  let holdTimer: number | null = null;
  const cancelHold = () => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  };

  canvas.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      const started: Press = { pointerId: event.pointerId, pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY, moved: false, held: false };
      press = started;
      clicks.lastPressMoved = false;
      // with the pointer captured, a lift outside the canvas still ends the drag
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // pointer may already be gone
      }
      bridge.start(event);
      cancelHold();
      if (event.pointerType === "touch") {
        holdTimer = window.setTimeout(() => {
          holdTimer = null;
          if (press !== started || started.moved) return;
          started.held = true;
          bridge.hold(event);
        }, LONG_PRESS_MS);
      }
    },
    capture,
  );
  canvas.addEventListener(
    "pointermove",
    (event) => {
      if (!event.isPrimary) return;
      if (press?.pointerId === event.pointerId && !press.moved) {
        const slop = press.pointerType === "touch" ? TOUCH_TAP_SLOP_PX : POINTER_TAP_SLOP_PX;
        press.moved = Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > slop;
        clicks.lastPressMoved = press.moved;
        if (press.moved) cancelHold();
      }
      // a finger has no hover: while nothing is being dragged, its moves preview nothing (a moved
      // touch places no vertex, so a sketch cursor following it would be left pointing nowhere)
      if (event.pointerType === "touch" && getState().editorInteraction.kind === "idle") return;
      bridge.move(event);
    },
    capture,
  );
  canvas.addEventListener(
    "pointerup",
    (event) => {
      if (press?.pointerId !== event.pointerId) return;
      cancelHold();
      const ended = press;
      press = null;
      bridge.end(event, ended);
    },
    capture,
  );
  canvas.addEventListener(
    "pointercancel",
    (event) => {
      if (press?.pointerId !== event.pointerId) return;
      cancelHold();
      // end the drag like a lift would, or the editor stays "dragging" with the viewport controls blocked
      press = null;
      bridge.release(event);
    },
    capture,
  );
  // Cancelling the touch events leaves the browser nothing to do with a touch on the canvas: no
  // text selection or loupe on a long press, no double-tap zoom, no scroll, and no synthetic
  // click (the pointer events above carry the gesture; a tap is clicked from them).
  canvas.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false, signal });
  canvas.addEventListener("contextmenu", (event) => editor.handleContextMenu(event), capture);
  canvas.addEventListener("dblclick", (event) => editor.handleDoubleClickAt(event.clientX, event.clientY), { signal });
  // the browser's click follows every mouse press; one that follows a drag, a pan or a double tap is not a click
  canvas.addEventListener("click", (event) => (isClickSuppressed() ? swallow(event) : editor.handleClick(event)), { signal });

  return () => {
    cancelHold();
    listeners.abort();
  };
}
