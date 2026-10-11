import { getState } from "@/features/core/store";
import type { EditorDeps } from "./editorActions";
import { createEditorTools2D } from "./polygonTools";

// The editor's pointer behaviour as the gesture layer sees it: one implementation per problem
// dimension (polygonTools is the polygon editor), chosen by createEditorTools. The gesture layer
// (ui/canvas/canvasGestures) normalizes mouse, pen and touch into these calls, in canvas
// coordinates, and owns the events; nothing here touches the DOM. The keyboard shortcuts hold for
// any editor and live in ui/canvas/canvasShortcuts.
export type EditorTools = {
  /** Hit-test a press; true when something was grabbed, which makes the gesture the editor's. */
  handleDragStart: (clientX: number, clientY: number) => boolean;
  handleDragMove: (clientX: number, clientY: number) => void;
  handleDragEnd: () => void;
  handleClick: (clientX: number, clientY: number) => void;
  handleDoubleClickAt: (clientX: number, clientY: number) => void;
  /** The right-click (or press-and-hold) edit; true when something under the pointer was acted on. */
  handleContextMenu: (clientX: number, clientY: number) => boolean;
  /** Drop any interaction in progress: the canvas is going away. */
  cleanup: () => void;
};

export type EditorToolsDeps = EditorDeps & {
  /** How close, in canvas pixels, a click must land to the first vertex to close the region. */
  closeHitRadiusPx: number;
};

/** The editor tools for the problem's dimension. A 3-variable editor plugs in here. */
export function createEditorTools(deps: EditorToolsDeps): EditorTools {
  const { dimension } = getState();
  if (dimension !== 2) throw new Error(`No editor for ${dimension}-variable problems yet.`);
  return createEditorTools2D(deps);
}
