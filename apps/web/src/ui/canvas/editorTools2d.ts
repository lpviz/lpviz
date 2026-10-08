import { createDragActions, updatePanControls } from "./canvasDragActions";
import { createEditActions } from "./canvasEditActions";
import type { EditorTools, EditorToolsDeps } from "./editorTools";

// The 2-variable polygon editor: vertices, edges and boundary rays dragged on the plane, the
// objective tip and the start marker, with clicks sketching and closing the polygon.
export function createEditorTools2D(deps: EditorToolsDeps): EditorTools {
  const drag = createDragActions(deps);
  const edit = createEditActions(deps);
  updatePanControls(deps.viewportApi);
  return {
    handleDragStart: drag.handleDragStart,
    handleDragMove: drag.handleDragMove,
    handleDragEnd: drag.handleDragEnd,
    handleClick: edit.handleClick,
    handleDoubleClickAt: edit.handleDoubleClickAt,
    handleContextMenu: edit.handleContextMenu,
    handleWheel: edit.handleWheel,
    handleKeyDown: edit.handleKeyDown,
    cleanup: drag.cleanupDragState,
  };
}
