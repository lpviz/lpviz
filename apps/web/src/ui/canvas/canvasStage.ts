import type { AppActions } from "@/app/appActions";
import { onAbort } from "@/features/core/lifetime";
import type { EditorDeps } from "@/features/polytope-editor/editorActions";
import { createEditorTools } from "@/features/polytope-editor/editorTools";
import { attachCanvasGestures } from "@/ui/canvas/canvasGestures";
import { attachCanvasShortcuts } from "@/ui/canvas/canvasShortcuts";
import { mountCanvasGL } from "@/ui/canvas/mountCanvasGL";
import { mountHelpButton } from "@/ui/canvas/mountHelpButton";
import { mountProblemGallery } from "@/ui/canvas/mountProblemGallery";
import { mountReplayDurationOverlay } from "@/ui/canvas/mountReplayDurationOverlay";
import { mountToolbar } from "@/ui/canvas/mountToolbar";
import { el } from "@/ui/dom";
import { hasCoarsePointer } from "@/ui/media";

// The canvas stage, in two steps. The GL canvas and its viewport runtime come first: the app's
// actions drive the runtime, and the sidebar, which precedes the stage in the document, holds
// the actions. The chrome around the canvas (toolbar, gallery, help, handle) and the editor's
// interactions mount once the actions exist.
export function createCanvasStage(parent: HTMLElement, signal: AbortSignal) {
  const main = el("main", { className: "canvas-stage" });
  const viewport = el("div", { className: "canvas-stage__viewport" });
  main.append(viewport);
  parent.append(main);
  const { viewportApi } = mountCanvasGL(viewport, signal);
  const canvas = viewportApi.getCanvasElement();
  canvas.focus();

  const mountChrome = ({ actions, editor, handle }: { actions: AppActions; editor: EditorDeps; handle: HTMLElement }) => {
    const replayDuration = mountReplayDurationOverlay(main, signal);
    // the editor for the problem's dimension, driven by the canvas's gestures; a finger needs a
    // more forgiving close target than a mouse cursor
    const tools = createEditorTools({ ...editor, closeHitRadiusPx: hasCoarsePointer() ? 24 : 12 });
    onAbort(signal, tools.cleanup);
    attachCanvasGestures(canvas, tools, signal);
    attachCanvasShortcuts(canvas, { ...actions, showReplayDuration: replayDuration.show }, signal);
    mountProblemGallery(main, actions, signal);
    mountToolbar(main, actions, signal);
    mountHelpButton(main, viewport, signal);
    main.append(handle);
  };

  return { viewportApi, mountChrome };
}
