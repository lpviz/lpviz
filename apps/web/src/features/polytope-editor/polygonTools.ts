import { getState, setState } from "@/features/core/store";
import { captureHistoryEntry, type HistoryEntry } from "@/features/history/historyState";
import { computeDrawingPhase } from "@/features/problem/selectors";
import { nearestEdge } from "@lpviz/math/polygon";
import { applyEditorTransition, dragPatch, updatePanControls, updatePointerPreview } from "./editorActions";
import { clickAt, deleteVertex, type EditorTransition, getEditorContext, insertOnEdge, insertOnRay, repairHull } from "./editorSession";
import type { DragTarget } from "./editorState";
import type { EditorTools, EditorToolsDeps } from "./editorTools";
import {
  EDGE_HIT_RADIUS_PX,
  exceedsDragThreshold,
  findBoundaryRayNearPoint,
  findVertexNearCanvasPoint,
  getCanvasFromClient,
  getDragStartTarget,
  getLogicalFromClient,
  solverStartNearCanvasPoint,
  worldDistanceForPixels,
} from "./hitTesting";

// What a press on each kind of target starts. `immediate`: the drag begins on the press rather
// than once the pointer has moved past the threshold (a vertex or constraint press may still be a
// click). `history`: the drag is an undoable edit of the drawing, which the start marker is not
// part of. `blocksOnPress`: the press itself takes the canvas from the pan and orbit controls,
// where a constraint press waits for the drag. `derives`: the drawing is re-derived when the drag
// ends; a moved start marker changes no geometry, and re-sending the polytope would reset any
// accumulated trace, when comparing paths from different starts is the point of dragging it.
const DRAG_POLICY: Record<DragTarget["kind"], { immediate: boolean; history: boolean; blocksOnPress: boolean; derives: boolean }> = {
  point: { immediate: false, history: true, blocksOnPress: true, derives: true },
  constraint: { immediate: false, history: true, blocksOnPress: false, derives: true },
  objective: { immediate: true, history: true, blocksOnPress: true, derives: true },
  "solver-start": { immediate: true, history: false, blocksOnPress: true, derives: false },
};

// The 2-variable polygon editor: vertices, edges and boundary rays dragged on the plane, the
// objective tip and the start marker; clicks sketch and close the polygon, a double click inserts
// a point, the context menu deletes one or resets the start marker.
export function createEditorTools2D(deps: EditorToolsDeps): EditorTools {
  const { viewportApi, saveHistory, derivePolytope, onSolverStartMoved, closeHitRadiusPx } = deps;
  const apply = (transition: EditorTransition) => applyEditorTransition(deps, transition);
  // the undo entry captured when a drag begins, saved on its first real move
  let pendingDragHistory: HistoryEntry | null = null;

  const restoreViewportControls = () => {
    viewportApi.setControlsBlocked(false);
    updatePanControls(viewportApi);
  };

  const cleanup = () => {
    pendingDragHistory = null;
    setState({ editorInteraction: { kind: "idle" } });
    restoreViewportControls();
    requestAnimationFrame(restoreViewportControls);
  };

  const handleDragStart = (clientX: number, clientY: number): boolean => {
    const state = getState();
    const target = getDragStartTarget(viewportApi, state, clientX, clientY);
    if (!target) return false;
    const policy = DRAG_POLICY[target.kind];
    if (policy.history) pendingDragHistory = captureHistoryEntry(state);
    setState({ editorInteraction: policy.immediate ? { kind: "dragging", target } : { kind: "pending-drag", target, dragStartPos: { x: clientX, y: clientY } } });
    if (policy.blocksOnPress) viewportApi.setControlsBlocked(true);
    return true;
  };

  const handleDragMove = (clientX: number, clientY: number) => {
    const initialState = getState();
    const initialInteraction = initialState.editorInteraction;
    const phaseSnapshot = computeDrawingPhase(initialState);
    if (initialInteraction.kind === "idle" && phaseSnapshot === "ready_for_solvers") return;

    const logicalCoords = getLogicalFromClient(viewportApi, clientX, clientY);
    if (initialInteraction.kind === "pending-drag" && exceedsDragThreshold(initialState, clientX, clientY)) {
      setState({ editorInteraction: { kind: "dragging", target: initialInteraction.target } });
      viewportApi.setControlsBlocked(true);
    }

    const state = getState();
    const interaction = state.editorInteraction;
    if (interaction.kind === "dragging") {
      if (pendingDragHistory) {
        saveHistory(pendingDragHistory);
        pendingDragHistory = null;
      }
      const { target } = interaction;
      const patch = dragPatch(target, logicalCoords, state);
      if (!patch) return;
      setState(patch);
      // the one drag that changes no geometry is the start marker's: the solver re-runs from it
      if (DRAG_POLICY[target.kind].derives) derivePolytope();
      else onSolverStartMoved();
      return;
    }
    updatePointerPreview(phaseSnapshot, logicalCoords);
  };

  const handleDragEnd = () => {
    const interaction = getState().editorInteraction;
    if (interaction.kind === "dragging") {
      setState({ editorInteraction: { kind: "idle" } });
      if (DRAG_POLICY[interaction.target.kind].derives) derivePolytope();
    }
    cleanup();
  };

  const handleContextMenu = (clientX: number, clientY: number) => {
    const state = getState();
    const canvasPoint = getCanvasFromClient(viewportApi, clientX, clientY);

    // right-clicking the start marker resets it to the solver default
    if (state.solverStartPoint && solverStartNearCanvasPoint(viewportApi, state, canvasPoint)) {
      setState({ solverStartPoint: null });
      onSolverStartMoved();
      return true;
    }

    const { vertices: displayVertices } = getEditorContext(state).geometry;
    const deleteIndex = findVertexNearCanvasPoint(viewportApi, canvasPoint, displayVertices);
    if (deleteIndex === -1) return false;

    apply(deleteVertex(state, deleteIndex));
    return true;
  };

  const handleDoubleClickAt = (clientX: number, clientY: number) => {
    const state = getState();
    const logicalMouse = getLogicalFromClient(viewportApi, clientX, clientY);
    const { vertices: displayVertices, mode: displayMode } = getEditorContext(state).geometry;
    const hullRepair = repairHull(state, logicalMouse);
    if (hullRepair.kind !== "noop") {
      apply(hullRepair);
      return;
    }

    const edgeIndex = nearestEdge(displayVertices, logicalMouse, worldDistanceForPixels(viewportApi, logicalMouse, EDGE_HIT_RADIUS_PX), displayMode === "closed");
    if (edgeIndex !== null) {
      const insertion = insertOnEdge(state, edgeIndex, logicalMouse);
      if (insertion.kind !== "noop") {
        apply(insertion);
        return;
      }
    }

    const rayIndex = findBoundaryRayNearPoint(viewportApi, state, logicalMouse);
    if (rayIndex !== null) {
      const insertion = insertOnRay(state, rayIndex, logicalMouse);
      if (insertion.kind !== "noop") apply(insertion);
    }
  };

  const handleClick = (clientX: number, clientY: number) => {
    const state = getState();
    // a click only sketches or places the objective; editing a finished region is drags and double-clicks
    const { session } = getEditorContext(state);
    if (session !== "drafting" && session !== "selecting-objective") return;
    const point = getLogicalFromClient(viewportApi, clientX, clientY);
    apply(clickAt(state, point, worldDistanceForPixels(viewportApi, point, closeHitRadiusPx)));
  };

  updatePanControls(viewportApi);
  return { handleDragStart, handleDragMove, handleDragEnd, handleClick, handleDoubleClickAt, handleContextMenu, cleanup };
}
