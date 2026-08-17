import type { AppContext } from "@/app/appContext";
import type { AppActions } from "@/features/core/actions";
import { ALL_VIEWPORT_DIRTY, setState } from "@/features/core/store";
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

export function boot(root: HTMLElement) {
  root.replaceChildren();

  let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  let mobileSidebarHeight = Math.round(window.innerHeight * 0.42);
  const mobileQuery = window.matchMedia(MOBILE_LAYOUT_QUERY);
  let mobileLayout = mobileQuery.matches;
  let canvasManager: ViewportRuntime | null = null;
  let urlApplied = false;
  let solverHandleProblemChange = () => {};

  const disposers: Array<() => void> = [];

  const history = createHistoryService(() => {
    canvasManager?.draw();
    polytope.send();
  });

  const polytope = createPolytopeService(() => solverHandleProblemChange);
  const solver = createSolverActions(() => canvasManager);
  const viewport = createViewportActions(() => canvasManager, sidebarWidth);
  const share = createShareService(() => solver.solverControls);

  solverHandleProblemChange = solver.handleProblemChange;

  const getViewportSidebarWidth = () => (mobileLayout ? 0 : sidebarWidth);
  const applyLayoutMode = () => {
    mobileLayout = mobileQuery.matches;
    root.classList.toggle("mobile-layout", mobileLayout);
    root.style.setProperty(
      "--mobile-sidebar-height",
      `${mobileSidebarHeight}px`,
    );
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

  const actions: AppActions = {
    setConstraintHighlight: solver.setConstraintHighlight,
    setIterateHighlight: solver.setIterateHighlight,

    updateSolverSetting: solver.updateSolverSetting,
    recomputeIfModeActive: solver.recomputeIfModeActive,
    setTraceEnabled: solver.setTraceEnabled,

    toggleReplay: solver.toggleReplay,
    startRotation: solver.startRotation,
    stopRotation: solver.stopRotation,

    share: share.share,

    zoomToFit: viewport.zoomToFit,
    resetView: viewport.resetView,
    toggle3D: viewport.toggle3D,
    setZScale: viewport.setZScale,

    setActiveSolverMode: (mode) => solver.setActiveSolverMode(mode, true),
    setSidebarWidth: viewport.setSidebarWidth,
    syncViewportLayout: viewport.syncViewportLayout,

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
    services: { history, polytope, solver, viewport },

    getCanvasManager: () => canvasManager,
    setCanvasManager,

    getSidebarWidth: () => sidebarWidth,
    getViewportSidebarWidth,
    isMobileLayout: () => mobileLayout,
    setSidebarWidthValue: (w) => {
      sidebarWidth = w;
    },

    disposers,
  };

  const sidebar = mountSidebar(root, ctx);

  // tracks the window listeners of an in-progress sidebar resize so destroy()
  // can remove them if teardown happens mid-drag
  let activeResizeCleanup: (() => void) | null = null;

  const onResizeStart = (startEvent: PointerEvent) => {
    if (mobileLayout) {
      const applyHeight = (clientY: number) => {
        mobileSidebarHeight = Math.max(
          180,
          Math.min(window.innerHeight * 0.72, window.innerHeight - clientY),
        );
        root.style.setProperty(
          "--mobile-sidebar-height",
          `${mobileSidebarHeight}px`,
        );
        viewport.setSidebarWidth(0);
        stage.updateLayout();
      };
      applyHeight(startEvent.clientY);

      const move = (event: PointerEvent) => {
        if (event.pointerId !== startEvent.pointerId) return;
        applyHeight(event.clientY);
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
        viewport.syncViewportLayout(0);
      };
      activeResizeCleanup = stop;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      return;
    }

    const applyWidth = (clientX: number) => {
      sidebarWidth = Math.max(260, Math.min(window.innerWidth - 240, clientX));
      ctx.setSidebarWidthValue(sidebarWidth);
      sidebar.updateWidth(sidebarWidth);
      viewport.setSidebarWidth(getViewportSidebarWidth());
      stage.updateLayout();
    };
    applyWidth(startEvent.clientX);

    const move = (event: PointerEvent) => {
      if (event.pointerId !== startEvent.pointerId) return;
      applyWidth(event.clientX);
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
      viewport.syncViewportLayout(getViewportSidebarWidth());
    };
    activeResizeCleanup = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const stage = mountCanvasStage(root, ctx, onResizeStart);

  const onResize = () => {
    mobileSidebarHeight = Math.min(
      mobileSidebarHeight,
      window.innerHeight * 0.72,
    );
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
      for (const d of disposers.splice(0)) d();
      root.replaceChildren();
    },
  };
}
