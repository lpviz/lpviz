import type { EditorActionDeps } from "@/features/polytope-editor/editorActions";

// The editor's pointer behaviour as the gesture layer sees it: one implementation per problem
// dimension (editorTools2d is the polygon editor), chosen by attachCanvasInteractions. The
// gesture layer normalizes mouse, pen and touch into these calls and knows nothing about what the
// editor does with them. The keyboard shortcuts hold for any editor and live in canvasShortcuts.
export type EditorTools = {
  /** Hit-test a press; true when something was grabbed, which makes the gesture the editor's. */
  handleDragStart: (clientX: number, clientY: number) => boolean;
  handleDragMove: (clientX: number, clientY: number) => void;
  handleDragEnd: () => void;
  handleClick: (event: MouseEvent) => void;
  handleDoubleClickAt: (clientX: number, clientY: number) => void;
  /** The right-click (or press-and-hold) edit; true when something under the pointer was acted on. */
  handleContextMenu: (event: MouseEvent) => boolean;
  /** Drop any interaction in progress: the canvas is going away. */
  cleanup: () => void;
};

export type EditorToolsDeps = EditorActionDeps & {
  /** Re-solve the active solver after the start marker moved or reset. */
  onSolverStartMoved: () => void;
};
