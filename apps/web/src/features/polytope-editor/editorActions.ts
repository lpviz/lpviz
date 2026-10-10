import { setCurrentMouse } from "@/features/core/currentMouse";
import { getState, setState } from "@/features/core/store";
import type { HistoryEntry } from "@/features/history/historyState";
import { type EditorTransition, getEditorTransition } from "@/features/polytope-editor/editorSession";
import { computeDrawingPhase, type DragTarget, type DrawingPhase } from "@/features/polytope-editor/editorState";
import type { ConstraintDragTarget } from "@/features/polytope-editor/hitTesting";
import type { ViewportApi } from "@/features/viewport/runtime";
import type { Vec } from "@lpviz/math/types";
import { verticesFromConstraints } from "@lpviz/polytope/halfSpaces";

// What the editor does to the store: applying a transition, finishing an open region, moving what
// a drag holds, previewing the pointer, and the pan rule. The canvas layer decides when; this
// module decides what.

export type EditorActionDeps = {
  viewportApi: ViewportApi;
  /** push an undo entry: the current state, or the one captured when a drag began */
  saveHistory: (entry?: HistoryEntry) => void;
  /** re-derive the polytope from the drawing and re-solve */
  derivePolytope: () => void;
};

/** The 2D view pans only once the drawing is finished; while drafting, a drag is part of the sketch. */
export const updatePanControls = (viewportApi: ViewportApi) => {
  viewportApi.set2DPanEnabled(computeDrawingPhase(getState()) === "ready_for_solvers");
};

// Every accepted transition is its own undoable step; an edit also clears the derived polytope
// for the re-derive. A rejection goes to the problem panel's message slot (the same one that
// shows "Nonconvex"), which the next accepted edit clears: no blocking dialog.
export function applyEditorTransition({ viewportApi, saveHistory, derivePolytope }: EditorActionDeps, transition: EditorTransition) {
  if (transition.kind === "noop") return;
  if (transition.kind === "reject-nonconvex") {
    setState({ inequalitiesMessage: transition.reason });
    return;
  }
  saveHistory();
  setState(transition.kind === "edit" ? { ...transition.result, polytope: null, inequalitiesMessage: null, highlightIndex: null } : { objectiveVector: transition.objectiveVector });
  derivePolytope();
  updatePanControls(viewportApi);
}

// Finishing the drafted region as an open one, by the Enter key or the console's link: finish-open
// yields noop, reject-nonconvex or edit, and only an edit clears the sketch cursor and hands the
// canvas back to panning.
export function finishOpenRegion(deps: EditorActionDeps) {
  const finished = getEditorTransition(getState(), { kind: "finish-open" });
  applyEditorTransition(deps, finished);
  if (finished.kind !== "edit") return;
  setCurrentMouse(null);
  deps.viewportApi.set2DPanEnabled(true);
}

// ---- drags ----

type DragDeps = { derivePolytope: () => void; onSolverStartMoved: () => void };

const applyConstraintDrag = (target: ConstraintDragTarget, logicalCoords: Vec, derivePolytope: () => void) => {
  const delta = (logicalCoords[0] - target.start[0]) * target.normal[0] + (logicalCoords[1] - target.start[1]) * target.normal[1];
  let operation: ConstraintDragTarget["operation"];

  if (target.operation.kind === "closed-line") {
    const line = target.operation.constraints[target.operation.lineIndex]!;
    const length = Math.hypot(line[0], line[1]);
    if (length <= 0) return;

    const shift = delta * length;
    const updatedLines = target.operation.constraints.slice();
    updatedLines[target.operation.lineIndex] = [line[0], line[1], line[2] + shift];
    const updatedVertices = verticesFromConstraints(updatedLines);
    if (updatedVertices.length < 2) return;

    setState({ vertices: updatedVertices });
    operation = { kind: "closed-line", lineIndex: target.operation.lineIndex, constraints: updatedLines };
  } else {
    operation = target.operation;
    const shiftX = target.normal[0] * delta;
    const shiftY = target.normal[1] * delta;
    const indices = new Set(operation.vertexIndices);
    setState({
      vertices: getState().vertices.map((v, i): Vec => (indices.has(i) ? [v[0] + shiftX, v[1] + shiftY] : v)),
    });
  }

  setState({
    editorInteraction: {
      kind: "dragging",
      target: { kind: "constraint", operation, start: logicalCoords, normal: target.normal },
    },
  });
  derivePolytope();
};

/** Moves whatever the drag holds (a vertex, a constraint, the start marker or the objective) to the pointer's logical position. */
export function applyDragTarget(dragTarget: DragTarget, logicalCoords: Vec, { derivePolytope, onSolverStartMoved }: DragDeps) {
  if (dragTarget.kind === "point") {
    const pointIndex = dragTarget.index;
    setState({
      vertices: getState().vertices.map((v, i) => (i === pointIndex ? logicalCoords : v)),
    });
    derivePolytope();
    return;
  }

  if (dragTarget.kind === "constraint") {
    applyConstraintDrag(dragTarget, logicalCoords, derivePolytope);
    return;
  }

  if (dragTarget.kind === "solver-start") {
    // store the raw point; the marker layer and the solver request both
    // derive the effective start (simplex snaps it to the nearest vertex)
    const off = dragTarget.grabOffset;
    setState({
      solverStartPoint: off ? [logicalCoords[0] + off[0], logicalCoords[1] + off[1]] : logicalCoords,
    });
    onSolverStartMoved();
    return;
  }

  setState({ objectiveVector: logicalCoords });
  derivePolytope();
}

/** The sketch cursor while drafting, the objective preview while placing the objective. */
export const updatePointerPreview = (phase: DrawingPhase, logicalCoords: Vec) => {
  if (phase === "empty" || phase === "sketching_polytope") setCurrentMouse(logicalCoords);
  else if (phase === "awaiting_objective" || phase === "objective_preview") setState({ currentObjective: logicalCoords });
};
