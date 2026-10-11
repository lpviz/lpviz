import { getState, setState } from "@/features/core/store";
import { captureHistoryEntry, type HistoryEntry } from "@/features/history/historyState";
import { applyDragTarget, updatePanControls, updatePointerPreview } from "./editorActions";
import { computeDrawingPhase } from "@/features/problem/selectors";
import type { EditorToolsDeps } from "./editorTools";
import { exceedsDragThreshold, getDragStartTarget, getLogicalFromClient } from "./hitTesting";

// The drag lifecycle: start (hit test + pending-drag), move (threshold, then
// apply) and end, plus the undo-history entry captured at the start and
// persisted on the first real move.
export function createDragActions(deps: EditorToolsDeps) {
  const { viewportApi, saveHistory, derivePolytope } = deps;
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
    setState({ editorInteraction: { kind: "idle" }, clickFollowsDrag: false });
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
      clickFollowsDrag: false,
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

    updatePointerPreview(phaseSnapshot, logicalCoords);
  };

  const handleDragEnd = () => {
    const interaction = getState().editorInteraction;
    if (interaction.kind === "dragging") {
      setState({ editorInteraction: { kind: "idle" }, clickFollowsDrag: true });
      // a moved start marker changes no geometry, and re-sending the polytope
      // would reset any accumulated trace (comparing paths from different
      // starts is the point of dragging it)
      if (interaction.target.kind !== "solver-start") derivePolytope();
    }

    cleanup();
  };

  return { cleanup, handleDragStart, handleDragMove, handleDragEnd };
}
