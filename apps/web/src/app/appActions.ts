import { freshState, getState, setState } from "@/features/core/store";
import type { HistoryService } from "@/features/history/historyService";
import { type EditorDeps, finishOpenRegion } from "@/features/polytope-editor/editorActions";
import type { GalleryProblem } from "@/features/problem-gallery/problems";
import type { SolverActions } from "@/features/solver/solverActions";
import { zoomFitTarget } from "@/features/viewport/bounds";
import { clampZScale } from "@lpviz/viewport/defaults";

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

// The action table the UI calls, its one way of changing the app: the solver actions above, the
// editor's toggles, the view actions, and the app-level composites.
export type AppActions = Pick<SolverActions, (typeof SOLVER_ACTION_KEYS)[number]> & {
  share: () => void;
  /** back to an empty canvas, with every setting at its default, after the person confirms */
  reset: () => void;
  loadGalleryProblem: (problem: GalleryProblem) => void;
  /** finish the drafted region as an open one, as Enter does; the console's link, for a finger */
  finishOpenRegion: () => void;
  undo: () => void;
  redo: () => void;
  toggleSnapToGrid: () => void;
  toggleObjectiveHidden: () => void;
  zoomToFit: () => void;
  resetView: () => void;
  toggle3D: () => void;
  /** the 3D height scale, clamped to its range */
  setZScale: (value: number) => void;
  /** pixels along the top of the canvas an overlay covers (the open gallery), which zoom-to-fit keeps clear */
  setTopInset: (px: number) => void;
  /** the sidebar's width changed, which resized the canvas too */
  setSidebarWidth: (width: number) => void;
};

const pick = <T, K extends keyof T>(source: T, ...keys: K[]): Pick<T, K> => Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<T, K>;

export function createAppActions({ solver, share, history, editor }: { solver: SolverActions; share: () => void; history: HistoryService; editor: EditorDeps }): AppActions {
  let topInset = 0;
  const { viewportApi } = editor;

  const resetView = () => viewportApi.resetView();
  const toggle3D = () => {
    const state = getState();
    if (!state.isTransitioning3D) viewportApi.start3DTransition(!state.is3DMode);
  };
  // the gallery strip, when open, is kept clear
  const zoomToFit = () => {
    const target = zoomFitTarget(getState());
    if (target) viewportApi.zoomToFit(target.bounds, target.zBounds, topInset);
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
      const { is3DMode, isTransitioning3D } = getState();
      if (is3DMode && !isTransitioning3D) toggle3D();
      viewportApi.afterTransition(resetView);
    },
    loadGalleryProblem: (problem) => {
      editor.saveHistory();
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
        rotateObjectiveMode: false,
        // any in-flight replay was already stopped by stopMotion() above;
        // clearing `replayActive` here without cancelling its RAF loop would
        // leave the loop running against the freshly loaded problem
      });
      editor.derivePolytope();
      window.requestAnimationFrame(() => zoomToFit());
    },
    finishOpenRegion: () => finishOpenRegion(editor),
    undo: () => history.handleUndoRedo(false),
    redo: () => history.handleUndoRedo(true),
    toggleSnapToGrid: () => setState({ snapToGrid: !getState().snapToGrid }),
    toggleObjectiveHidden: () => setState({ objectiveHidden: !getState().objectiveHidden }),

    // ---- the view ----
    resetView,
    toggle3D,
    zoomToFit,
    setZScale: (value) => setState({ zScale: clampZScale(value) }),
    setTopInset: (px) => {
      topInset = Math.max(0, px);
    },
    setSidebarWidth: (width) => viewportApi.setSidebarWidth(width),
  };
}
