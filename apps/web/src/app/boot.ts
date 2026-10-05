import type { AppContext } from "@/app/appContext";
import type { AppActions } from "@/features/core/actions";
import { ALL_VIEWPORT_DIRTY, freshState, getState, on, setState } from "@/features/core/store";
import { createHistoryService } from "@/features/history/historyService";
import { createPolytopeService } from "@/features/polytope-editor/polytopeService";
import type { GalleryProblem } from "@/features/problem-gallery/problems";
import { createShareService } from "@/features/share/shareService";
import { applyUrlParamsOnce } from "@/features/share/urlParamsSync";
import { createSolverActions } from "@/features/solver/solverActions";
import type { ViewportRuntime } from "@/features/viewport/runtime";
import { createViewportActions } from "@/features/viewport/viewportActions";
import { mountCanvasStage } from "@/ui/canvas/mountCanvasStage";
import { mountSidebar } from "@/ui/sidebar/mountSidebar";

const DEFAULT_SIDEBAR_WIDTH = 450;
const MOBILE_LAYOUT_QUERY = "(max-width: 700px) and (orientation: portrait)";

const pick = <T, K extends keyof T>(source: T, ...keys: K[]): Pick<T, K> => Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<T, K>;

export function boot(root: HTMLElement) {
  root.replaceChildren();

  let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  let mobileSidebarHeight = Math.round(window.innerHeight * 0.42);
  const mobileQuery = window.matchMedia(MOBILE_LAYOUT_QUERY);
  let mobileLayout = mobileQuery.matches;
  let canvasManager: ViewportRuntime | null = null;
  let urlApplied = false;

  const history = createHistoryService(() => {
    canvasManager?.draw();
    polytope.send();
  });

  const solver = createSolverActions(() => canvasManager);
  const polytope = createPolytopeService(solver.handleProblemChange);
  const viewport = createViewportActions(() => canvasManager, sidebarWidth);
  const share = createShareService(() => solver.solverControls);

  const getViewportSidebarWidth = () => (mobileLayout ? 0 : sidebarWidth);
  const applyLayoutMode = () => {
    mobileLayout = mobileQuery.matches;
    root.classList.toggle("mobile-layout", mobileLayout);
    root.style.setProperty("--mobile-sidebar-height", `${mobileSidebarHeight}px`);
  };
  applyLayoutMode();

  const setCanvasManager = (runtime: ViewportRuntime | null) => {
    canvasManager = runtime;
    if (runtime && !urlApplied) {
      urlApplied = true;
      applyUrlParamsOnce({
        canvasManager: runtime,
        solverControls: solver.solverControls,
        updateSolverSetting: solver.updateSolverSetting,
        invalidatePendingSolveResults: solver.invalidatePendingSolveResults,
        setActiveSolverMode: solver.setActiveSolverMode,
        sendPolytope: polytope.send,
      });
    }
  };

  // Run `fn` once the viewport is not mid-transition between 2D and 3D: now if
  // it is not, otherwise when the running transition completes.
  const afterViewTransition = (fn: () => void) => {
    if (!getState().isTransitioning3D) {
      fn();
      return;
    }
    const controller = new AbortController();
    on(
      ["isTransitioning3D"],
      ({ isTransitioning3D }) => {
        if (isTransitioning3D) return;
        controller.abort();
        fn();
      },
      controller.signal,
    );
  };

  const actions: AppActions = {
    ...pick(solver, "setConstraintHighlight", "setIterateHighlight", "updateSolverSetting", "recomputeIfModeActive", "setTraceEnabled", "toggleReplay", "startRotation", "stopRotation"),
    share: share.share,
    reset: () => {
      if (!window.confirm("Reset lpviz? This clears the drawing and every setting.")) return;
      // In place rather than by reloading the page, so it works offline.
      solver.invalidatePendingSolveResults();
      solver.stopRotation();
      solver.clearComputedState();
      setState(freshState(), { viewportDirty: ALL_VIEWPORT_DIRTY });
      // pan is enabled on an empty canvas; the first vertex placed turns it
      // off until the region is finished
      canvasManager?.set2DPanEnabled(true);
      const { is3DMode, isTransitioning3D } = getState();
      if (is3DMode && !isTransitioning3D) viewport.toggle3D();
      afterViewTransition(() => {
        viewport.resetView();
        canvasManager?.draw();
      });
    },

    ...pick(viewport, "zoomToFit", "resetView", "toggle3D", "setZScale", "setSidebarWidth", "syncViewportLayout"),
    setActiveSolverMode: (mode) => solver.setActiveSolverMode(mode, true),

    loadGalleryProblem: (problem: GalleryProblem) => {
      history.save();
      solver.invalidatePendingSolveResults();
      solver.stopRotation();
      setState(
        {
          vertices: problem.vertices.map((v) => ({ ...v })),
          completionMode: "closed",
          interiorPoint: { ...problem.interiorPoint },
          polytope: null,
          inequalitiesMessage: null,
          objectiveVector: { ...problem.objectiveVector },
          currentObjective: null,
          highlightIndex: null,
          highlightIteratePathIndex: null,
          editorInteraction: { kind: "idle" },
          lastCompletedInteraction: "none",
          rotateObjectiveMode: false,
          // any in-flight replay was already stopped by stopRotation() above;
          // clearing `replayActive` here without cancelling its RAF loop would
          // leave the loop running against the freshly loaded problem
        },
        { viewportDirty: ALL_VIEWPORT_DIRTY },
      );
      canvasManager?.set2DPanEnabled(true);
      polytope.send();
      canvasManager?.draw();
      window.requestAnimationFrame(() => viewport.zoomToFit());
    },
  };

  const ctx: AppContext = {
    actions,
    services: { history, polytope, viewport },

    getCanvasManager: () => canvasManager,
    setCanvasManager,

    getSidebarWidth: () => sidebarWidth,
    getViewportSidebarWidth,
    isMobileLayout: () => mobileLayout,
  };

  const sidebar = mountSidebar(root, ctx);

  // tracks the window listeners of an in-progress sidebar resize so destroy()
  // can remove them if teardown happens mid-drag
  let activeResizeCleanup: (() => void) | null = null;

  // Follows one pointer from `startEvent` until it lifts: `apply` sees the
  // start event and every move, `onUp` runs once after the listeners are gone.
  const trackPointerDrag = (startEvent: PointerEvent, apply: (event: PointerEvent) => void, onUp: () => void) => {
    apply(startEvent);
    const move = (event: PointerEvent) => {
      if (event.pointerId !== startEvent.pointerId) return;
      apply(event);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      activeResizeCleanup = null;
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== startEvent.pointerId) return;
      stop();
      onUp();
    };
    activeResizeCleanup = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const applyHeight = (event: PointerEvent) => {
    mobileSidebarHeight = Math.max(180, Math.min(window.innerHeight * 0.72, window.innerHeight - event.clientY));
    root.style.setProperty("--mobile-sidebar-height", `${mobileSidebarHeight}px`);
    viewport.setSidebarWidth(0);
    stage.updateLayout();
  };
  const applyWidth = (event: PointerEvent) => {
    sidebarWidth = Math.max(260, Math.min(window.innerWidth - 240, event.clientX));
    sidebar.updateWidth(sidebarWidth);
    viewport.setSidebarWidth(getViewportSidebarWidth());
    stage.updateLayout();
  };
  const onResizeStart = (startEvent: PointerEvent) =>
    mobileLayout
      ? trackPointerDrag(startEvent, applyHeight, () => viewport.syncViewportLayout(0))
      : trackPointerDrag(startEvent, applyWidth, () => viewport.syncViewportLayout(getViewportSidebarWidth()));

  const stage = mountCanvasStage(root, ctx, onResizeStart);

  const onResize = () => {
    mobileSidebarHeight = Math.min(mobileSidebarHeight, window.innerHeight * 0.72);
    applyLayoutMode();
    viewport.syncViewportLayout(getViewportSidebarWidth());
    stage.updateLayout();
  };
  window.addEventListener("resize", onResize);
  mobileQuery.addEventListener("change", onResize);

  return {
    destroy: () => {
      activeResizeCleanup?.();
      window.removeEventListener("resize", onResize);
      mobileQuery.removeEventListener("change", onResize);
      stage.destroy();
      sidebar.destroy();
      solver.destroy();
      root.replaceChildren();
    },
  };
}
