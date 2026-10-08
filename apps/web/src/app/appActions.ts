import { freshState, getState, on, setState, type SolverMode } from "@/features/core/store";
import type { HistoryService } from "@/features/history/historyService";
import type { PolytopeService } from "@/features/polytope-editor/polytopeService";
import type { GalleryProblem } from "@/features/problem-gallery/problems";
import type { SolverActions } from "@/features/solver/solverActions";
import { ALL_VIEWPORT_DIRTY } from "@/features/viewport/dirtyFlags";
import type { ViewportRuntime } from "@/features/viewport/runtime";
import type { ViewportActions } from "@/features/viewport/viewportActions";

// The action table the UI panels call: the solver and viewport actions they use directly, plus
// the app-level composites.
export type AppActions = Pick<
  SolverActions,
  "setConstraintHighlight" | "setIterateHighlight" | "updateSolverSetting" | "recomputeIfModeActive" | "setTraceEnabled" | "toggleReplay" | "startRotation" | "stopMotion"
> &
  Pick<ViewportActions, "zoomToFit" | "resetView" | "toggle3D" | "setZScale" | "setSidebarWidth" | "syncViewportLayout"> & {
    share: () => void;
    /** back to an empty canvas, with every setting at its default, after the person confirms */
    reset: () => void;
    setActiveSolverMode: (mode: SolverMode) => void;
    loadGalleryProblem: (problem: GalleryProblem) => void;
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
  viewport,
  share,
  history,
  polytope,
  getViewportApi,
}: {
  solver: SolverActions;
  viewport: ViewportActions;
  share: { share: () => void };
  history: HistoryService;
  polytope: PolytopeService;
  getViewportApi: () => ViewportRuntime | null;
}): AppActions {
  return {
    ...pick(solver, "setConstraintHighlight", "setIterateHighlight", "updateSolverSetting", "recomputeIfModeActive", "setTraceEnabled", "toggleReplay", "startRotation", "stopMotion"),
    share: share.share,
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
      if (is3DMode && !isTransitioning3D) viewport.toggle3D();
      afterViewTransition(() => {
        viewport.resetView();
        getViewportApi()?.draw();
      });
    },

    ...pick(viewport, "zoomToFit", "resetView", "toggle3D", "setZScale", "setSidebarWidth", "syncViewportLayout"),
    setActiveSolverMode: (mode) => solver.setActiveSolverMode(mode, true),

    loadGalleryProblem: (problem: GalleryProblem) => {
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
      viewportApi?.draw();
      window.requestAnimationFrame(() => viewport.zoomToFit());
    },
  };
}
