import type { HandleUndoRedo, SaveHistory } from "@/features/history/historyService";
import type { ViewportApi } from "@/features/viewport/runtime";
import { createDragActions, updatePanControls } from "./canvasDragActions";
import { createEditActions } from "./canvasEditActions";
import { createCanvasGestures } from "./canvasGestures";

export function attachCanvasInteractions(deps: {
  canvasManager: ViewportApi;
  saveHistory: SaveHistory;
  sendPolytope: () => void;
  handleUndoRedo: HandleUndoRedo;
  /** Re-solve the active solver after the start marker moved or reset. */
  onSolverStartMoved: () => void;
  showReplayDuration: (durationMs: number) => void;
}): () => void {
  const { canvasManager } = deps;
  const canvas = canvasManager.getCanvasElement();
  const gestures = createCanvasGestures(canvas);
  const drag = createDragActions(deps);
  const edit = createEditActions({ ...deps, isClickSuppressed: gestures.isClickSuppressed });

  updatePanControls(canvasManager);

  const detachGestures = gestures.attach({
    handleDragStart: drag.handleDragStart,
    handleDragMove: drag.handleDragMove,
    handleDragEnd: drag.handleDragEnd,
    handleClick: edit.handleClick,
    handleDoubleClickAt: edit.handleDoubleClickAt,
    handleContextMenu: edit.handleContextMenu,
    handleWheel: edit.handleWheel,
    handleKeyDown: edit.handleKeyDown,
  });

  return () => {
    drag.cleanupDragState();
    detachGestures();
  };
}
