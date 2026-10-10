import { freshState, getState, on, setState } from "@/features/core/store";
import type { SolverMode } from "@/features/solver/solverState";
import type { HistoryService } from "@/features/history/historyService";
import type { PolytopeService } from "@/features/polytope-editor/polytopeService";
import type { GalleryProblem } from "@/features/problem-gallery/problems";
import type { SolverActions } from "@/features/solver/solverActions";
import { collectZoomFitBounds, UNBOUNDED_CLIP_BOUNDS } from "@/features/viewport/bounds";
import { ALL_VIEWPORT_DIRTY } from "@/features/viewport/dirtyFlags";
import type { ViewportRuntime } from "@/features/viewport/runtime";
import { DEFAULT_FIT_PADDING } from "@lpviz/viewport/defaults";

// The action table the UI panels call: the solver actions they use directly, the view actions,
// and the app-level composites.
export type AppActions = Pick<
  SolverActions,
  "setConstraintHighlight" | "setIterateHighlight" | "updateSolverSetting" | "recomputeIfModeActive" | "setTraceEnabled" | "toggleReplay" | "startRotation" | "stopMotion"
> & {
  share: () => void;
  /** back to an empty canvas, with every setting at its default, after the person confirms */
  reset: () => void;
  setActiveSolverMode: (mode: SolverMode) => void;
  loadGalleryProblem: (problem: GalleryProblem) => void;
  zoomToFit: () => void;
  resetView: () => void;
  toggle3D: () => void;
  setZScale: (value: number) => void;
  /** pixels along the top of the canvas an overlay covers (the open gallery), which zoom-to-fit keeps clear */
  setTopInset: (px: number) => void;
  /** the sidebar's width changed, which resized the canvas too */
  setSidebarWidth: (width: number) => void;
};

const pick = <T, K extends keyof T>(source: T, ...keys: K[]): Pick<T, K> => Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<T, K>;

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

export function createAppActions({
  solver,
  share,
  history,
  polytope,
  getViewportApi,
  initialSidebarWidth,
}: {
  solver: SolverActions;
  share: () => void;
  history: HistoryService;
  polytope: PolytopeService;
  getViewportApi: () => ViewportRuntime | null;
  initialSidebarWidth: number;
}): AppActions {
  let sidebarWidth = initialSidebarWidth;
  let topInset = 0;

  const resetView = () => getViewportApi()?.resetView();
  const toggle3D = () => {
    const viewportApi = getViewportApi();
    const state = getState();
    if (viewportApi && !state.isTransitioning3D) viewportApi.start3DTransition(!state.is3DMode);
  };
  // an unbounded open region is fitted to its clip box; the gallery strip, when open, is kept clear
  const zoomToFit = () => {
    const viewportApi = getViewportApi();
    if (!viewportApi) return;
    const state = getState();
    const isOpenUnbounded = state.completionMode === "open" && state.polytope?.kind === "unbounded";
    const zoomFit = collectZoomFitBounds(state);
    if (!zoomFit && !isOpenUnbounded) return;
    viewportApi.zoomToFit(isOpenUnbounded ? UNBOUNDED_CLIP_BOUNDS : zoomFit!.bounds, DEFAULT_FIT_PADDING, zoomFit?.zBounds, topInset);
    viewportApi.setSidebarWidth(sidebarWidth);
  };

  return {
    ...pick(solver, "setConstraintHighlight", "setIterateHighlight", "updateSolverSetting", "recomputeIfModeActive", "setTraceEnabled", "toggleReplay", "startRotation", "stopMotion"),
    share,
    reset: () => {
      if (!window.confirm("Reset lpviz? This clears the drawing and every setting.")) return;
      const viewportApi = getViewportApi();
      // In place rather than by reloading the page, so it works offline.
      solver.invalidatePendingSolveResults();
      solver.stopMotion();
      solver.clearComputedState();
      setState(freshState(), { viewportDirty: ALL_VIEWPORT_DIRTY });
      // pan is enabled on an empty canvas; the first vertex placed turns it
      // off until the region is finished
      viewportApi?.set2DPanEnabled(true);
      const { is3DMode, isTransitioning3D } = getState();
      if (is3DMode && !isTransitioning3D) toggle3D();
      afterViewTransition(resetView);
    },
    setActiveSolverMode: (mode) => solver.setActiveSolverMode(mode, true),
    loadGalleryProblem: (problem) => {
      const viewportApi = getViewportApi();
      history.save();
      solver.invalidatePendingSolveResults();
      solver.stopMotion();
      setState(
        {
          vertices: problem.vertices.map((v) => [...v]),
          completionMode: "closed",
          interiorPoint: [...problem.interiorPoint],
          polytope: null,
          inequalitiesMessage: null,
          objectiveVector: [...problem.objectiveVector],
          currentObjective: null,
          highlightIndex: null,
          highlightIteratePathIndex: null,
          editorInteraction: { kind: "idle" },
          lastCompletedInteraction: "none",
          rotateObjectiveMode: false,
          // any in-flight replay was already stopped by stopMotion() above;
          // clearing `replayActive` here without cancelling its RAF loop would
          // leave the loop running against the freshly loaded problem
        },
        { viewportDirty: ALL_VIEWPORT_DIRTY },
      );
      viewportApi?.set2DPanEnabled(true);
      polytope.send();
      window.requestAnimationFrame(() => zoomToFit());
    },

    // ---- the view ----
    resetView,
    toggle3D,
    zoomToFit,
    setZScale: (value) => setState({ zScale: value }),
    setTopInset: (px) => {
      topInset = Math.max(0, px);
    },
    setSidebarWidth: (width) => {
      sidebarWidth = width;
      getViewportApi()?.setSidebarWidth(width);
    },
  };
}
