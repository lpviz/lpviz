import { createEditorTools, type EditorToolsDeps } from "@/features/polytope-editor/editorTools";
import { attachCanvasGestures } from "./canvasGestures";

/** The editor for the problem's dimension, driven by the canvas's gestures; returns the detach. */
export function attachCanvasInteractions(deps: EditorToolsDeps): () => void {
  const tools = createEditorTools(deps);
  const detachGestures = attachCanvasGestures(deps.viewportApi.getCanvasElement(), tools);
  return () => {
    tools.cleanup();
    detachGestures();
  };
}
