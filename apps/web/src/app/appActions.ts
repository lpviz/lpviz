import type { AppActions } from "@/features/core/actions";
import { ALL_VIEWPORT_DIRTY, freshState, getState, on, setState } from "@/features/core/store";
import type { HistoryService } from "@/features/history/historyService";
import type { PolytopeService } from "@/features/polytope-editor/polytopeService";
import type { GalleryProblem } from "@/features/problem-gallery/problems";
import type { SolverActions } from "@/features/solver/solverActions";
import type { ViewportRuntime } from "@/features/viewport/runtime";
import type { ViewportActions } from "@/features/viewport/viewportActions";

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

// The action table the UI panels call: the solver and viewport actions they
// use directly, plus the two app-level composites (reset, gallery load).
export function createAppActions({
  solver,
  viewport,
  share,
  history,
  polytope,
  getCanvasManager,
}: {
  solver: SolverActions;
  viewport: ViewportActions;
  share: { share: () => void };
  history: HistoryService;
  polytope: PolytopeService;
  getCanvasManager: () => ViewportRuntime | null;
}): AppActions {
  return {
    ...pick(solver, "setConstraintHighlight", "setIterateHighlight", "updateSolverSetting", "recomputeIfModeActive", "setTraceEnabled", "toggleReplay", "startRotation", "stopRotation"),
    share: share.share,
    reset: () => {
      if (!window.confirm("Reset lpviz? This clears the drawing and every setting.")) return;
      const canvasManager = getCanvasManager();
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
        getCanvasManager()?.draw();
      });
    },

    ...pick(viewport, "zoomToFit", "resetView", "toggle3D", "setZScale", "setSidebarWidth", "syncViewportLayout"),
    setActiveSolverMode: (mode) => solver.setActiveSolverMode(mode, true),

    loadGalleryProblem: (problem: GalleryProblem) => {
      const canvasManager = getCanvasManager();
      history.save();
      solver.invalidatePendingSolveResults();
      solver.stopRotation();
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
}
