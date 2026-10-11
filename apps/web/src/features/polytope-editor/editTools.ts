import { getState, setState } from "@/features/core/store";
import { nearestEdge } from "@lpviz/math/polygon";
import { type EditorTransition, getEditorContext, getEditorTransition } from "./editorSession";
import type { EditorToolsDeps } from "./editorTools";
import { EDGE_HIT_RADIUS_PX, findBoundaryRayNearPoint, findVertexNearCanvasPoint, getCanvasFromClient, getLogicalFromClient, solverStartNearCanvasPoint, worldDistanceForPixels } from "./hitTesting";

// The polygon editor's click, double-click and context-menu edits.
export function createEditActions(
  { viewportApi, onSolverStartMoved, closeHitRadiusPx }: Pick<EditorToolsDeps, "viewportApi" | "onSolverStartMoved" | "closeHitRadiusPx">,
  applyEditorTransition: (transition: EditorTransition) => void,
) {
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

    applyEditorTransition(getEditorTransition(state, { kind: "delete-vertex", deleteIndex }));
    return true;
  };

  const handleDoubleClickAt = (clientX: number, clientY: number) => {
    const state = getState();
    const logicalMouse = getLogicalFromClient(viewportApi, clientX, clientY);
    const { vertices: displayVertices, mode: displayMode } = getEditorContext(state).geometry;
    const hullRepair = getEditorTransition(state, { kind: "repair-displayed-hull", point: logicalMouse });
    if (hullRepair.kind !== "noop") {
      applyEditorTransition(hullRepair);
      return;
    }

    const edgeIndex = nearestEdge(displayVertices, logicalMouse, worldDistanceForPixels(viewportApi, logicalMouse, EDGE_HIT_RADIUS_PX), displayMode === "closed");
    if (edgeIndex !== null) {
      const insertion = getEditorTransition(state, { kind: "insert-edge-point", edgeIndex, point: logicalMouse });
      if (insertion.kind !== "noop") {
        applyEditorTransition(insertion);
        return;
      }
    }

    const rayIndex = findBoundaryRayNearPoint(viewportApi, state, logicalMouse);
    if (rayIndex !== null) {
      const insertion = getEditorTransition(state, { kind: "insert-boundary-ray-point", rayIndex, point: logicalMouse });
      if (insertion.kind !== "noop") applyEditorTransition(insertion);
    }
  };

  const handleClick = (clientX: number, clientY: number) => {
    const state = getState();
    if (state.clickFollowsDrag) {
      setState({ clickFollowsDrag: false });
      return;
    }

    // a click only sketches or places the objective; editing a finished region is drags and double-clicks
    const { session } = getEditorContext(state);
    if (session !== "drafting" && session !== "selecting-objective") return;
    const point = getLogicalFromClient(viewportApi, clientX, clientY);
    applyEditorTransition(getEditorTransition(state, { kind: "click", point, closeThreshold: worldDistanceForPixels(viewportApi, point, closeHitRadiusPx) }));
  };

  return { handleContextMenu, handleDoubleClickAt, handleClick };
}
