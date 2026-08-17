import type { AppContext } from "@/app/appContext";
import { getState, on } from "@/features/core/store";
import { createViewportRuntime } from "@/features/viewport/runtime";
import { attachCanvasInteractions } from "@/ui/canvas/canvasInteractions";
import { mountCanvasGL } from "@/ui/canvas/mountCanvasGL";
import { mountHelpButton } from "@/ui/canvas/mountHelpButton";
import { mountProblemGallery } from "@/ui/canvas/mountProblemGallery";
import { mountReplayDurationOverlay } from "@/ui/canvas/mountReplayDurationOverlay";
import { el } from "@/ui/dom";

export function mountCanvasStage(
  parent: HTMLElement,
  ctx: AppContext,
  onResizeStart: (event: PointerEvent) => void,
) {
  const main = el("main", { className: "canvas-stage" });
  const viewport = el("div", { className: "canvas-stage__viewport" });
  main.append(viewport);
  parent.append(main);
  const replayDuration = mountReplayDurationOverlay(main);
  let detachInteractions: (() => void) | null = null;
  let destroyed = false;
  const gl = mountCanvasGL(
    viewport,
    (bridge) => {
      bridge.getCanvasElement().focus();
      void createViewportRuntime({ viewportBridge: bridge })
        .then((runtime) => {
          if (destroyed) {
            // the stage was torn down while the runtime was initializing;
            // registering it now would resurrect a destroyed canvas manager
            // and leak the window listeners attachCanvasInteractions installs
            runtime.destroy();
            return;
          }
          ctx.setCanvasManager(runtime);
          detachInteractions = attachCanvasInteractions({
            canvasManager: runtime,
            saveHistory: ctx.services.history.save,
            sendPolytope: ctx.services.polytope.send,
            handleUndoRedo: ctx.services.history.handleUndoRedo,
            onSolverStartMoved: () =>
              ctx.actions.recomputeIfModeActive(getState().solverMode),
            showReplayDuration: replayDuration.show,
          });
          ctx.services.viewport.syncViewportLayout(
            ctx.getViewportSidebarWidth(),
          );
          runtime.draw();
        })
        .catch((e) => console.error("Failed to initialize viewport", e));
    },
    () => ctx.setCanvasManager(null),
  );
  const gallery = mountProblemGallery(main, ctx);
  const zoom = el("div", { id: "zoomControls" });
  const reset = el("button", { attrs: { title: "Reset Zoom (Home)" } });
  reset.innerHTML =
    '<svg width="25" height="25" viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>';
  reset.addEventListener("click", () => ctx.actions.resetView());
  const fit = el("button", { attrs: { title: "Zoom" } });
  fit.innerHTML =
    '<svg width="25" height="25" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><mask id="hole-mask"><rect width="100" height="100" fill="white" /><circle cx="40" cy="40" r="20" fill="black" /></mask></defs><circle cx="40" cy="40" r="32.5" mask="url(#hole-mask)" /><g transform="translate(55,55) rotate(45)"><rect x="0" y="-4" width="52.5" height="15" /></g></svg>';
  fit.addEventListener("click", () => ctx.actions.zoomToFit());
  const toggle3d = el("button", {
    id: "toggle3DButton",
    attrs: { title: "Toggle 3D Mode" },
  });
  toggle3d.addEventListener("click", () => ctx.actions.toggle3D());
  const share = el("button", {
    id: "shareButton",
    attrs: { title: "Share this configuration" },
  });
  share.innerHTML =
    '<svg fill="currentColor" width="25" height="25" viewBox="0 0 24 24"><path d="M20,21H4a2,2,0,0,1-2-2V6A2,2,0,0,1,4,4H8A1,1,0,0,1,8,6H4V19H20V13a1,1,0,0,1,2,0v6A2,2,0,0,1,20,21Z"></path><path d="M21.62,6.22l-5-4a1,1,0,0,0-1.05-.12A1,1,0,0,0,15,3V4.19a9.79,9.79,0,0,0-7,7.65,1,1,0,0,0,.62,1.09A1,1,0,0,0,9,13a1,1,0,0,0,.83-.45C11,10.78,13.58,10.24,15,10.07V11a1,1,0,0,0,.57.9,1,1,0,0,0,1.05-.12l5-4a1,1,0,0,0,0-1.56Z"></path></svg>';
  share.addEventListener("click", () => ctx.actions.share());
  const zc = el("div", { id: "zScaleSliderContainer" });
  const zs = el("input", {
    attrs: {
      type: "range",
      id: "zScaleSlider",
      min: "0.01",
      max: "10",
      step: "0.01",
      orient: "vertical",
      title: "Adjust Z-axis scale",
    },
  }) as HTMLInputElement;
  const zv = el("div", { id: "zScaleValue" });
  zs.addEventListener("input", () =>
    ctx.actions.setZScale(parseFloat(zs.value)),
  );
  zc.append(
    el("label", { attrs: { for: "zScaleSlider" }, text: "Scale" }),
    zs,
    zv,
  );
  zoom.append(reset, fit, toggle3d, share, zc);
  main.append(zoom);
  const help = mountHelpButton(main);
  const handle = el("div", { id: "sidebarHandle" });
  handle.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    onResizeStart(e);
  });
  main.append(handle);
  function render() {
    const { is3DMode, zScale } = getState();
    toggle3d.className = is3DMode ? "button-active" : "";
    toggle3d.textContent = is3DMode ? "2D" : "3D";
    zs.value = String(zScale);
    zv.textContent = zScale.toFixed(2);
    zc.className = is3DMode ? "" : "is-hidden";
    const sw = ctx.getSidebarWidth();
    handle.style.left = ctx.isMobileLayout() ? "0" : `${sw}px`;
    gallery.update();
  }
  render();
  const controller = new AbortController();
  on(["is3DMode", "zScale"], render, controller.signal);
  return {
    updateLayout: render,
    destroy: () => {
      destroyed = true;
      controller.abort();
      detachInteractions?.();
      ctx.getCanvasManager()?.destroy();
      gl.destroy();
      gallery.destroy();
      help.destroy();
      replayDuration.destroy();
      main.remove();
    },
  };
}
