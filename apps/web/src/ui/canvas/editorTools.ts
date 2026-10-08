import type { HandleUndoRedo, SaveHistory } from "@/features/history/historyService";
import type { ViewportApi } from "@/features/viewport/runtime";

// The editor's pointer and keyboard behaviour as the gesture layer sees it: one implementation per
// problem dimension (editorTools2d is the polygon editor), chosen by attachCanvasInteractions. The
// gesture layer normalizes mouse, pen and touch into these calls and knows nothing about what the
// editor does with them.
export type EditorTools = {
  /** Hit-test a press; true when something was grabbed, which makes the gesture the editor's. */
  handleDragStart: (clientX: number, clientY: number) => boolean;
  handleDragMove: (clientX: number, clientY: number) => void;
  handleDragEnd: () => void;
  handleClick: (event: MouseEvent) => void;
  handleDoubleClickAt: (clientX: number, clientY: number) => void;
  handleContextMenu: (event: MouseEvent) => void;
  handleWheel: (event: WheelEvent) => void;
  handleKeyDown: (event: KeyboardEvent) => void;
  /** Drop any interaction in progress: the canvas is going away. */
  cleanup: () => void;
};

export type EditorToolsDeps = {
  viewportApi: ViewportApi;
  saveHistory: SaveHistory;
  sendPolytope: () => void;
  handleUndoRedo: HandleUndoRedo;
  /** Re-solve the active solver after the start marker moved or reset. */
  onSolverStartMoved: () => void;
  showReplayDuration: (durationMs: number) => void;
  // the gesture layer's "this click is the synthetic one after a double tap"
  isClickSuppressed: () => boolean;
};
