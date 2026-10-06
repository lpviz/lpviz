import { setCurrentMouse } from "@/features/core/currentMouse";
import { computeDrawingPhase, getState, setState, type DragTarget, type DrawingPhase, type EditorInteractionState, type HistoryEntry, type State } from "@/features/core/store";
import type { SaveHistory } from "@/features/history/historyService";
import { exceedsDragThreshold, getDragStartTarget, getLogicalFromClient, type ConstraintDragTarget } from "@/features/polytope-editor/interactionState";
import type { ViewportApi } from "@/features/viewport/runtime";
import { verticesFromLines } from "@lpviz/math/geometry";
import type { PointXY } from "@lpviz/math/types";

const DRAG_COMPLETION: Record<DragTarget["kind"], State["lastCompletedInteraction"]> = {
  point: "dragged-point",
  constraint: "dragged-constraint",
  "solver-start": "dragged-start",
  objective: "dragged-objective",
};

type DragActionDeps = {
  canvasManager: ViewportApi;
  saveHistory: SaveHistory;
  sendPolytope: () => void;
  /** Re-solve the active solver after the start marker moved or reset. */
  onSolverStartMoved: () => void;
};

export const updatePanControls = (canvasManager: ViewportApi) => {
  canvasManager.set2DPanEnabled(computeDrawingPhase(getState()) === "ready_for_solvers");
};

const captureHistoryEntry = (state: Pick<State, "vertices" | "objectiveVector" | "completionMode">): HistoryEntry => ({
  vertices: state.vertices.map((v) => ({ x: v.x, y: v.y })),
  objectiveVector: state.objectiveVector ? { ...state.objectiveVector } : null,
  completionMode: state.completionMode,
});

const applyConstraintDrag = (target: ConstraintDragTarget, logicalCoords: PointXY, canvasManager: ViewportApi, sendPolytope: () => void) => {
  const delta = (logicalCoords.x - target.start.x) * target.normal.x + (logicalCoords.y - target.start.y) * target.normal.y;
  let operation: ConstraintDragTarget["operation"];

  if (target.operation.kind === "closed-line") {
    const line = target.operation.lines[target.operation.lineIndex]!;
    const length = Math.hypot(line[0], line[1]);
    if (length <= 0) return;

    const shift = delta * length;
    const updatedLines = target.operation.lines.slice();
    updatedLines[target.operation.lineIndex] = [line[0], line[1], line[2] + shift];
    const updatedVertices = verticesFromLines(updatedLines);
    if (updatedVertices.length < 2) return;

    setState({ vertices: updatedVertices.map(([x, y]) => ({ x, y })) });
    operation = { kind: "closed-line", lineIndex: target.operation.lineIndex, lines: updatedLines };
  } else {
    operation = target.operation;
    const shiftX = target.normal.x * delta;
    const shiftY = target.normal.y * delta;
    const indices = new Set(operation.vertexIndices);
    setState({
      vertices: getState().vertices.map((v, i) => (indices.has(i) ? { x: v.x + shiftX, y: v.y + shiftY } : v)),
    });
  }

  setState({
    editorInteraction: {
      kind: "dragging",
      target: { kind: "constraint", operation, start: logicalCoords, normal: target.normal },
    },
  });
  sendPolytope();
  canvasManager.draw();
};

// moves whatever the drag holds (a vertex, a constraint, the start marker or
// the objective) to the pointer's logical position
const applyDragTarget = (dragTarget: DragTarget, logicalCoords: PointXY, { canvasManager, sendPolytope, onSolverStartMoved }: Omit<DragActionDeps, "saveHistory">) => {
  if (dragTarget.kind === "point") {
    const pointIndex = dragTarget.index;
    setState({
      vertices: getState().vertices.map((v, i) => (i === pointIndex ? logicalCoords : v)),
    });
    sendPolytope();
    canvasManager.draw();
    return;
  }

  if (dragTarget.kind === "constraint") {
    applyConstraintDrag(dragTarget, logicalCoords, canvasManager, sendPolytope);
    return;
  }

  if (dragTarget.kind === "solver-start") {
    // store the raw point; the marker layer and the solver request both
    // derive the effective start (simplex snaps it to the nearest vertex)
    const off = dragTarget.grabOffset;
    setState({
      solverStartPoint: off ? { x: logicalCoords.x + off.x, y: logicalCoords.y + off.y } : logicalCoords,
    });
    onSolverStartMoved();
    canvasManager.draw();
    return;
  }

  setState({ objectiveVector: logicalCoords });
  sendPolytope();
  canvasManager.draw();
};

const updatePointerPreview = (phase: DrawingPhase, logicalCoords: PointXY, canvasManager: ViewportApi) => {
  if (phase === "empty" || phase === "sketching_polytope") {
    setCurrentMouse(logicalCoords);
    canvasManager.draw();
    return;
  }

  if (phase === "awaiting_objective" || phase === "objective_preview") {
    setState({ currentObjective: logicalCoords });
    canvasManager.draw();
  }
};

// The drag lifecycle: start (hit test + pending-drag), move (threshold, then
// apply) and end, plus the undo-history entry captured at the start and
// persisted on the first real move.
export function createDragActions(deps: DragActionDeps) {
  const { canvasManager, saveHistory, sendPolytope } = deps;
  let pendingDragHistory: HistoryEntry | null = null;

  const persistPendingDragHistory = () => {
    if (!pendingDragHistory) return;
    saveHistory(pendingDragHistory);
    pendingDragHistory = null;
  };

  const restoreViewportControls = () => {
    canvasManager.setControlsBlocked(false);
    updatePanControls(canvasManager);
  };

  const cleanupDragState = () => {
    pendingDragHistory = null;
    setState({
      editorInteraction: { kind: "idle" },
      lastCompletedInteraction: "none",
    });
    restoreViewportControls();
    requestAnimationFrame(restoreViewportControls);
  };

  const applyDraggingInteraction = (interaction: Extract<EditorInteractionState, { kind: "dragging" }>, logicalCoords: PointXY) => {
    persistPendingDragHistory();
    applyDragTarget(interaction.target, logicalCoords, deps);
  };

  const handleDragStart = (clientX: number, clientY: number): boolean => {
    const state = getState();
    const target = getDragStartTarget(canvasManager, state, clientX, clientY);
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
      canvasManager.setControlsBlocked(true);
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
      canvasManager.setControlsBlocked(true);
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

    const logicalCoords = getLogicalFromClient(canvasManager, clientX, clientY);
    if (initialInteraction.kind === "pending-drag" && exceedsDragThreshold(initialState, clientX, clientY)) {
      setState({
        editorInteraction: {
          kind: "dragging",
          target: initialInteraction.target,
        },
      });
      canvasManager.setControlsBlocked(true);
    }

    const state = getState();
    const interaction = state.editorInteraction;

    if (interaction.kind === "dragging") {
      applyDraggingInteraction(interaction, logicalCoords);
      return;
    }

    updatePointerPreview(phaseSnapshot, logicalCoords, canvasManager);
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

    cleanupDragState();
  };

  return { cleanupDragState, handleDragStart, handleDragMove, handleDragEnd };
}
