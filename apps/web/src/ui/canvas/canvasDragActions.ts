import { setCurrentMouse } from "@/features/core/currentMouse";
import { getState, setState, type State } from "@/features/core/store";
import { computeDrawingPhase, type DragTarget, type DrawingPhase } from "@/features/polytope-editor/editorState";
import { captureHistoryEntry, type HistoryEntry } from "@/features/history/historyState";
import { exceedsDragThreshold, getDragStartTarget, getLogicalFromClient, type ConstraintDragTarget } from "@/features/polytope-editor/hitTesting";
import type { ViewportApi } from "@/features/viewport/runtime";
import { verticesFromConstraints } from "@lpviz/polytope/halfSpaces";
import type { Vec } from "@lpviz/math/types";
import type { EditorToolsDeps } from "./editorTools";

const DRAG_COMPLETION: Record<DragTarget["kind"], State["lastCompletedInteraction"]> = {
  point: "dragged-point",
  constraint: "dragged-constraint",
  "solver-start": "dragged-start",
  objective: "dragged-objective",
};

type DragActionDeps = Pick<EditorToolsDeps, "viewportApi" | "saveHistory" | "sendPolytope" | "onSolverStartMoved">;

export const updatePanControls = (viewportApi: ViewportApi) => {
  viewportApi.set2DPanEnabled(computeDrawingPhase(getState()) === "ready_for_solvers");
};

const applyConstraintDrag = (target: ConstraintDragTarget, logicalCoords: Vec, viewportApi: ViewportApi, sendPolytope: () => void) => {
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
  sendPolytope();
  viewportApi.draw();
};

// moves whatever the drag holds (a vertex, a constraint, the start marker or
// the objective) to the pointer's logical position
const applyDragTarget = (dragTarget: DragTarget, logicalCoords: Vec, { viewportApi, sendPolytope, onSolverStartMoved }: Omit<DragActionDeps, "saveHistory">) => {
  if (dragTarget.kind === "point") {
    const pointIndex = dragTarget.index;
    setState({
      vertices: getState().vertices.map((v, i) => (i === pointIndex ? logicalCoords : v)),
    });
    sendPolytope();
    viewportApi.draw();
    return;
  }

  if (dragTarget.kind === "constraint") {
    applyConstraintDrag(dragTarget, logicalCoords, viewportApi, sendPolytope);
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
    viewportApi.draw();
    return;
  }

  setState({ objectiveVector: logicalCoords });
  sendPolytope();
  viewportApi.draw();
};

const updatePointerPreview = (phase: DrawingPhase, logicalCoords: Vec, viewportApi: ViewportApi) => {
  if (phase === "empty" || phase === "sketching_polytope") {
    setCurrentMouse(logicalCoords);
    viewportApi.draw();
    return;
  }

  if (phase === "awaiting_objective" || phase === "objective_preview") {
    setState({ currentObjective: logicalCoords });
    viewportApi.draw();
  }
};

// The drag lifecycle: start (hit test + pending-drag), move (threshold, then
// apply) and end, plus the undo-history entry captured at the start and
// persisted on the first real move.
export function createDragActions(deps: DragActionDeps) {
  const { viewportApi, saveHistory, sendPolytope } = deps;
  let pendingDragHistory: HistoryEntry | null = null;

  const persistPendingDragHistory = () => {
    if (!pendingDragHistory) return;
    saveHistory(pendingDragHistory);
    pendingDragHistory = null;
  };

  const restoreViewportControls = () => {
    viewportApi.setControlsBlocked(false);
    updatePanControls(viewportApi);
  };

  const cleanup = () => {
    pendingDragHistory = null;
    setState({
      editorInteraction: { kind: "idle" },
      lastCompletedInteraction: "none",
    });
    restoreViewportControls();
    requestAnimationFrame(restoreViewportControls);
  };

  const handleDragStart = (clientX: number, clientY: number): boolean => {
    const state = getState();
    const target = getDragStartTarget(viewportApi, state, clientX, clientY);
    if (!target) return false;

    if (target.kind === "objective" || target.kind === "solver-start") {
      // the start marker is not part of the drawing, so it never enters the
      // undo history
      if (target.kind === "objective") {
        pendingDragHistory = captureHistoryEntry(state);
      }
      setState({
        editorInteraction: { kind: "dragging", target },
      });
      viewportApi.setControlsBlocked(true);
      return true;
    }

    setState({
      editorInteraction: {
        kind: "pending-drag",
        target,
        dragStartPos: { x: clientX, y: clientY },
      },
      lastCompletedInteraction: "none",
    });
    pendingDragHistory = captureHistoryEntry(state);
    if (target.kind === "point") {
      viewportApi.setControlsBlocked(true);
    }
    return true;
  };

  const handleDragMove = (clientX: number, clientY: number) => {
    const initialState = getState();
    const initialInteraction = initialState.editorInteraction;
    const phaseSnapshot = computeDrawingPhase(initialState);
    if (initialInteraction.kind === "idle" && phaseSnapshot === "ready_for_solvers") {
      return;
    }

    const logicalCoords = getLogicalFromClient(viewportApi, clientX, clientY);
    if (initialInteraction.kind === "pending-drag" && exceedsDragThreshold(initialState, clientX, clientY)) {
      setState({
        editorInteraction: {
          kind: "dragging",
          target: initialInteraction.target,
        },
      });
      viewportApi.setControlsBlocked(true);
    }

    const state = getState();
    const interaction = state.editorInteraction;

    if (interaction.kind === "dragging") {
      persistPendingDragHistory();
      applyDragTarget(interaction.target, logicalCoords, deps);
      return;
    }

    updatePointerPreview(phaseSnapshot, logicalCoords, viewportApi);
  };

  const handleDragEnd = () => {
    const interaction = getState().editorInteraction;
    if (interaction.kind === "dragging") {
      setState({
        editorInteraction: { kind: "idle" },
        lastCompletedInteraction: DRAG_COMPLETION[interaction.target.kind],
      });
      // a moved start marker changes no geometry, and re-sending the polytope
      // would reset any accumulated trace (comparing paths from different
      // starts is the point of dragging it)
      if (interaction.target.kind !== "solver-start") sendPolytope();
    }

    cleanup();
  };

  return { cleanup, handleDragStart, handleDragMove, handleDragEnd };
}
