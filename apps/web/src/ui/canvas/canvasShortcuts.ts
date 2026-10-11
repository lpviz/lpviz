import type { AppActions } from "@/app/appActions";
import { getState } from "@/features/core/store";
import { stepReplayDurationMs } from "@/features/solver/replayDuration";
import { dominantWheelDelta, swallow } from "@/ui/dom";
import { DEFAULT_Z_SCALE } from "@lpviz/viewport/defaults";

export type CanvasShortcutDeps = Pick<AppActions, "undo" | "redo" | "finishOpenRegion" | "toggleSnapToGrid" | "toggleObjectiveHidden" | "setZScale" | "updateSolverSetting"> & {
  showReplayDuration: (durationMs: number) => void;
};

const isTextEntryTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

// The shortcuts that hold for any editor: undo/redo, Enter (leave the region open), S (snap to
// grid), H (hide the objective), + and - (the animation's length) and, in 3D, shift+wheel (the z
// scale).
export function attachCanvasShortcuts(canvas: HTMLCanvasElement, deps: CanvasShortcutDeps): () => void {
  const { undo, redo, showReplayDuration, finishOpenRegion, toggleSnapToGrid, toggleObjectiveHidden, setZScale, updateSolverSetting } = deps;
  const listeners = new AbortController();
  const { signal } = listeners;

  // "+" lengthens the replay, "-" shortens it; the readout shows on every press, including one
  // that hits an end of the range, so the keys never feel dead
  const adjustReplayDuration = (direction: 1 | -1) => {
    const { solverSettings } = getState();
    const replayDurationMs = stepReplayDurationMs(solverSettings.replayDurationMs, direction);
    if (replayDurationMs !== solverSettings.replayDurationMs) updateSolverSetting("replayDurationMs", replayDurationMs);
    showReplayDuration(replayDurationMs);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // this is a window-level capture handler; typing in form fields must not
    // trigger canvas shortcuts (or block native text-editing undo)
    if (isTextEntryTarget(event.target)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
    if (event.key === "Enter") {
      // let a focused button or link activate natively
      if (event.target instanceof HTMLElement && event.target.closest("button, a, [role='button']")) {
        return;
      }
      event.preventDefault();
      finishOpenRegion();
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() === "s") toggleSnapToGrid();
    if (event.key.toLowerCase() === "h") toggleObjectiveHidden();
    // "=" and "_" are the unshifted/shifted twins of "+" and "-", so both
    // layouts of each key work. Checked after the modifier guard above so
    // ctrl/cmd +/- stays browser zoom.
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      adjustReplayDuration(1);
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      adjustReplayDuration(-1);
    }
  };

  // shift+wheel in 3D scales the z axis
  const onWheel = (event: WheelEvent) => {
    const { is3DMode, isTransitioning3D, zScale } = getState();
    if (!is3DMode || isTransitioning3D || !event.shiftKey) return;

    swallow(event);

    const zoomFactor = 1.05;
    const dominantDelta = dominantWheelDelta(event);
    if (dominantDelta === 0) return;

    setZScale((zScale || DEFAULT_Z_SCALE) * (dominantDelta < 0 ? 1 / zoomFactor : zoomFactor));
  };

  window.addEventListener("keydown", onKeyDown, { capture: true, signal });
  canvas.addEventListener("wheel", onWheel, { capture: true, passive: false, signal });
  return () => listeners.abort();
}
