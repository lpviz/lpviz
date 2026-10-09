import { createDragActions, updatePanControls } from "./canvasDragActions";
import { createEditActions } from "./canvasEditActions";
import type { EditorTools, EditorToolsDeps } from "./editorTools";

// The 2-variable polygon editor: vertices, edges and boundary rays dragged on the plane, the
// objective tip and the start marker, with clicks sketching and closing the polygon.
export function createEditorTools2D(deps: EditorToolsDeps): EditorTools {
  const tools = { ...createDragActions(deps), ...createEditActions(deps) };
  updatePanControls(deps.viewportApi);
  return tools;
}
