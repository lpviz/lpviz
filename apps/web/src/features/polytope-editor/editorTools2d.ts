import { createDragActions } from "./dragTools";
import { applyEditorTransition, updatePanControls } from "./editorActions";
import type { EditorTools, EditorToolsDeps } from "./editorTools";
import { createEditActions } from "./editTools";

// The 2-variable polygon editor: vertices, edges and boundary rays dragged on the plane, the
// objective tip and the start marker, with clicks sketching and closing the polygon.
export function createEditorTools2D(deps: EditorToolsDeps): EditorTools {
  const tools = { ...createDragActions(deps), ...createEditActions(deps, (transition) => applyEditorTransition(deps, transition)) };
  updatePanControls(deps.viewportApi);
  return tools;
}
