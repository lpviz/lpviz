import { getState } from "@/features/core/store";
import { createCanvasGestures } from "./canvasGestures";
import type { EditorTools, EditorToolsDeps } from "./editorTools";
import { createEditorTools2D } from "./editorTools2d";

// The editor tools for the problem's dimension. A 3-variable editor plugs in here.
function createEditorTools(deps: EditorToolsDeps): EditorTools {
  const { dimension } = getState();
  if (dimension !== 2) throw new Error(`No editor for ${dimension}-variable problems yet.`);
  return createEditorTools2D(deps);
}

export function attachCanvasInteractions(deps: Omit<EditorToolsDeps, "isClickSuppressed">): () => void {
  const canvas = deps.canvasManager.getCanvasElement();
  const gestures = createCanvasGestures(canvas);
  const tools = createEditorTools({ ...deps, isClickSuppressed: gestures.isClickSuppressed });
  const detachGestures = gestures.attach(tools);

  return () => {
    tools.cleanup();
    detachGestures();
  };
}
