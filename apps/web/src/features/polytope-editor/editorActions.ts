import { setCurrentMouse } from "@/features/core/currentMouse";
import { getState, setState, type State } from "@/features/core/store";
import type { HistoryEntry } from "@/features/history/historyState";
import { type EditorTransition, finishOpen as finishOpenTransition } from "@/features/polytope-editor/editorSession";
import type { DrawingPhase } from "@/features/problem/selectors";
import { type DragTarget } from "@/features/polytope-editor/editorState";
import type { ConstraintDragTarget } from "@/features/polytope-editor/hitTesting";
import type { ViewportApi } from "@/features/viewport/runtime";
import type { Vec } from "@lpviz/math/types";
import { verticesFromConstraints } from "@lpviz/polytope/halfSpaces";

// What the editor does to the store: applying a transition, finishing an open region, moving what
// a drag holds and previewing the pointer. The canvas layer decides when; this module decides what.

/** What the editor acts through: the viewport, the undo history, the derive and the solver's re-run. */
export type EditorDeps = {
  viewportApi: ViewportApi;
  /** push an undo entry: the current state, or the one captured when a drag began */
  saveHistory: (entry?: HistoryEntry) => void;
  /** re-derive the polytope from the drawing and re-solve */
  derivePolytope: () => void;
  /** re-solve the active solver after the start marker moved or reset */
  onSolverStartMoved: () => void;
};

// Every accepted transition is its own undoable step; an edit also clears the derived polytope
// for the re-derive. A rejection goes to the problem panel's message slot (the same one that
// shows "Nonconvex"), which the next accepted edit clears: no blocking dialog.
export function applyEditorTransition({ saveHistory, derivePolytope }: EditorDeps, transition: EditorTransition) {
  if (transition.kind === "noop") return;
  if (transition.kind === "reject-nonconvex") {
    setState({ inequalitiesMessage: transition.reason });
    return;
  }
  saveHistory();
  setState(transition.kind === "edit" ? { ...transition.result, polytope: null, inequalitiesMessage: null, highlightIndex: null } : { objectiveVector: transition.objectiveVector });
  derivePolytope();
}

// Finishing the drafted region as an open one, by the Enter key or the console's link: finish-open
// yields noop, reject-nonconvex or edit, and only an edit clears the sketch cursor.
export function finishOpenRegion(deps: EditorDeps) {
  const finished = finishOpenTransition(getState());
  applyEditorTransition(deps, finished);
  if (finished.kind === "edit") setCurrentMouse(null);
}

// ---- drags ----

// A constraint's edge dragged: the pointer's travel along the normal moves the whole line. A
// closed region's line shifts and its vertices are rebuilt from the lines (null when that leaves
// no region); an open region's two vertices move with it. The drag continues from the pointer.
function constraintDragPatch(target: ConstraintDragTarget, at: Vec, state: State): Partial<State> | null {
  const delta = (at[0] - target.start[0]) * target.normal[0] + (at[1] - target.start[1]) * target.normal[1];
  let operation: ConstraintDragTarget["operation"];
  let vertices: Vec[];
  if (target.operation.kind === "closed-line") {
    const line = target.operation.constraints[target.operation.lineIndex]!;
    const length = Math.hypot(line[0], line[1]);
    if (length <= 0) return null;
    const updatedLines = target.operation.constraints.slice();
    updatedLines[target.operation.lineIndex] = [line[0], line[1], line[2] + delta * length];
    vertices = verticesFromConstraints(updatedLines);
    if (vertices.length < 2) return null;
    operation = { kind: "closed-line", lineIndex: target.operation.lineIndex, constraints: updatedLines };
  } else {
    operation = target.operation;
    const shiftX = target.normal[0] * delta;
    const shiftY = target.normal[1] * delta;
    const indices = new Set(operation.vertexIndices);
    vertices = state.vertices.map((v, i): Vec => (indices.has(i) ? [v[0] + shiftX, v[1] + shiftY] : v));
  }
  return { vertices, editorInteraction: { kind: "dragging", target: { kind: "constraint", operation, start: at, normal: target.normal } } };
}

/** The store patch that moves what a drag holds (a vertex, a constraint, the start marker or the objective) to `at`; null when the move leaves no region. */
export function dragPatch(target: DragTarget, at: Vec, state: State): Partial<State> | null {
  switch (target.kind) {
    case "point":
      return { vertices: state.vertices.map((v, i) => (i === target.index ? at : v)) };
    case "constraint":
      return constraintDragPatch(target, at, state);
    case "solver-start": {
      // the raw point; the marker layer and the solver request both derive the effective start
      // (simplex snaps it to the nearest vertex)
      const off = target.grabOffset;
      return { solverStartPoint: off ? [at[0] + off[0], at[1] + off[1]] : at };
    }
    case "objective":
      return { objectiveVector: at };
  }
}

/** The sketch cursor while drafting, the objective preview while placing the objective. */
export const updatePointerPreview = (phase: DrawingPhase, logicalCoords: Vec) => {
  if (phase === "empty" || phase === "sketching_polytope") setCurrentMouse(logicalCoords);
  else if (phase === "awaiting_objective" || phase === "objective_preview") setState({ currentObjective: logicalCoords });
};
