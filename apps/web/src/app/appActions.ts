import { freshState, getState, on, setState } from "@/features/core/store";
import type { HistoryService } from "@/features/history/historyService";
import { finishOpenRegion } from "@/features/polytope-editor/editorActions";
import type { PolytopeService } from "@/features/polytope-editor/polytopeService";
import type { GalleryProblem } from "@/features/problem-gallery/problems";
import type { SolverActions } from "@/features/solver/solverActions";
import { collectZoomFitBounds, UNBOUNDED_CLIP_BOUNDS } from "@/features/viewport/bounds";
import type { ViewportApi } from "@/features/viewport/runtime";

// the solver actions the UI panels call directly
const SOLVER_ACTION_KEYS = [
  "setActiveSolverMode",
  "setConstraintHighlight",
  "setIterateHighlight",
  "updateSolverSetting",
  "recomputeIfModeActive",
  "setTraceEnabled",
  "toggleReplay",
  "startRotation",
  "stopMotion",
] as const;

// The action table the UI panels call: the solver actions above, the view actions, and the
// app-level composites.
export type AppActions = Pick<SolverActions, (typeof SOLVER_ACTION_KEYS)[number]> & {
  share: () => void;
  /** back to an empty canvas, with every setting at its default, after the person confirms */
  reset: () => void;
  loadGalleryProblem: (problem: GalleryProblem) => void;
  /** finish the drafted region as an open one, as Enter does; the console's link, for a finger */
  finishOpenRegion: () => void;
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
  viewportApi,
}: {
  solver: SolverActions;
  share: () => void;
  history: HistoryService;
  polytope: PolytopeService;
  viewportApi: ViewportApi;
}): AppActions {
  let topInset = 0;
  const editor = { viewportApi, saveHistory: history.save, derivePolytope: polytope.derive };

  const resetView = () => viewportApi.resetView();
  const toggle3D = () => {
    const state = getState();
    if (!state.isTransitioning3D) viewportApi.start3DTransition(!state.is3DMode);
  };
  // an unbounded open region is fitted to its clip box; the gallery strip, when open, is kept clear
  const zoomToFit = () => {
    const state = getState();
    const isOpenUnbounded = state.completionMode === "open" && state.polytope?.kind === "unbounded";
    const zoomFit = collectZoomFitBounds(state);
    if (!zoomFit && !isOpenUnbounded) return;
    viewportApi.zoomToFit(isOpenUnbounded ? UNBOUNDED_CLIP_BOUNDS : zoomFit!.bounds, zoomFit?.zBounds, topInset);
  };

  return {
    ...pick(solver, ...SOLVER_ACTION_KEYS),
    share,
    reset: () => {
      if (!window.confirm("Reset lpviz? This clears the drawing and every setting.")) return;
      // In place rather than by reloading the page, so it works offline.
      solver.stopMotion();
      solver.clearComputedState();
      setState(freshState());
      // pan is enabled on an empty canvas; the first vertex placed turns it
      // off until the region is finished
      viewportApi.set2DPanEnabled(true);
      const { is3DMode, isTransitioning3D } = getState();
      if (is3DMode && !isTransitioning3D) toggle3D();
      afterViewTransition(resetView);
    },
    loadGalleryProblem: (problem) => {
      history.save();
      solver.stopMotion();
      setState({
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
        clickFollowsDrag: false,
        rotateObjectiveMode: false,
        // any in-flight replay was already stopped by stopMotion() above;
        // clearing `replayActive` here without cancelling its RAF loop would
        // leave the loop running against the freshly loaded problem
      });
      viewportApi.set2DPanEnabled(true);
      polytope.derive();
      window.requestAnimationFrame(() => zoomToFit());
    },
    finishOpenRegion: () => finishOpenRegion(editor),

    // ---- the view ----
    resetView,
    toggle3D,
    zoomToFit,
    setZScale: (value) => setState({ zScale: value }),
    setTopInset: (px) => {
      topInset = Math.max(0, px);
    },
    setSidebarWidth: (width) => viewportApi.setSidebarWidth(width),
  };
}
