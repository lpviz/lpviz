import { setCurrentMouse } from "@/features/core/currentMouse";
import { getState, setState } from "@/features/core/store";
import { type EditorTransition, getEditorTransition } from "@/features/polytope-editor/editorSession";
import { computeDrawingPhase } from "@/features/polytope-editor/editorState";
import type { ViewportApi } from "@/features/viewport/runtime";

export type EditorActionDeps = {
  viewportApi: ViewportApi;
  saveHistory: () => void;
  /** re-derive the polytope from the drawing and re-solve */
  derivePolytope: () => void;
};

/** The 2D view pans only once the drawing is finished; while drafting, a drag is part of the sketch. */
export const updatePanControls = (viewportApi: ViewportApi) => {
  viewportApi.set2DPanEnabled(computeDrawingPhase(getState()) === "ready_for_solvers");
};

// What the editor does with a transition (every accepted edit is its own undoable step, and the
// derived polytope is cleared for the re-derive), and the one edit that is reached from outside
// the canvas: finishing an open region, by the Enter key or by the console's link.
export function createEditorActions({ viewportApi, saveHistory, derivePolytope }: EditorActionDeps) {
  const apply = (transition: EditorTransition) => {
    if (transition.kind === "reject-nonconvex") {
      // The problem panel's message slot (the same one that shows "Nonconvex");
      // the next accepted edit clears it. No blocking dialog.
      setState({ inequalitiesMessage: transition.reason });
      return;
    }

    if (transition.kind === "edit") {
      saveHistory();
      setState({ ...transition.result, polytope: null, inequalitiesMessage: null, highlightIndex: null });
      derivePolytope();
      updatePanControls(viewportApi);
      return;
    }

    if (transition.kind === "select-objective") {
      saveHistory();
      setState({ objectiveVector: transition.objectiveVector });
      derivePolytope();
      updatePanControls(viewportApi);
    }
  };

  // finish-open yields noop, reject-nonconvex or edit; only an edit clears
  // the sketch cursor and hands the canvas back to panning
  const finishOpenRegion = () => {
    const finished = getEditorTransition(getState(), { kind: "finish-open" });
    apply(finished);
    if (finished.kind !== "edit") return;
    setCurrentMouse(null);
    viewportApi.set2DPanEnabled(true);
  };

  return { apply, finishOpenRegion };
}
