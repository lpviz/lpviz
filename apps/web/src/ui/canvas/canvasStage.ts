import type { AppContext } from "@/app/appContext";
import { createEditorTools } from "@/features/polytope-editor/editorTools";
import { createViewportRuntime } from "@/features/viewport/runtime";
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
export function createCanvasStage(parent: HTMLElement) {
  const main = el("main", { className: "canvas-stage" });
  const viewport = el("div", { className: "canvas-stage__viewport" });
  main.append(viewport);
  parent.append(main);
  const gl = mountCanvasGL(viewport);
  const viewportApi = createViewportRuntime({ viewportBridge: gl.bridge });
  gl.bridge.getCanvasElement().focus();
  let destroyChrome: (() => void) | null = null;

  const mountChrome = (ctx: AppContext) => {
    const replayDuration = mountReplayDurationOverlay(main);
    // the editor for the problem's dimension, driven by the canvas's gestures; a finger needs a
    // more forgiving close target than a mouse cursor
    const tools = createEditorTools({ ...ctx.editor, closeHitRadiusPx: hasCoarsePointer() ? 24 : 12 });
    const detachGestures = attachCanvasGestures(gl.bridge.getCanvasElement(), tools);
    const detachShortcuts = attachCanvasShortcuts(gl.bridge.getCanvasElement(), { ...ctx.actions, showReplayDuration: replayDuration.show });
    const gallery = mountProblemGallery(main, ctx.actions);
    const toolbar = mountToolbar(main, ctx.actions);
    const help = mountHelpButton(main, viewport);
    const handle = el("div", {
      id: "sidebarHandle",
      on: {
        pointerdown(e) {
          if (!e.isPrimary || e.button !== 0) return;
          e.preventDefault();
          this.setPointerCapture(e.pointerId);
          ctx.layout.onResizeStart(e);
        },
      },
    });
    main.append(handle);
    destroyChrome = () => {
      detachShortcuts();
      tools.cleanup();
      detachGestures();
      gallery.destroy();
      toolbar.destroy();
      help.destroy();
      replayDuration.destroy();
    };
  };

  return {
    viewportApi,
    mountChrome,
    destroy: () => {
      destroyChrome?.();
      viewportApi.destroy();
      gl.destroy();
      main.remove();
    },
  };
}
