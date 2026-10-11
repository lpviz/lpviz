import { getState, setState } from "@/features/core/store";
import { type EditorTransition, getEditorContext, getEditorTransition } from "@/features/polytope-editor/editorSession";
import {
  EDGE_HIT_RADIUS_PX,
  findBoundaryRayNearPoint,
  findVertexNearCanvasPoint,
  getCanvasFromClient,
  getLogicalFromClient,
  solverStartNearCanvasPoint,
  worldDistanceForPixels,
} from "@/features/polytope-editor/hitTesting";
import { swallow } from "@/ui/dom";
import { hasCoarsePointer } from "@/ui/media";
import { nearestEdge } from "@lpviz/math/polygon";
import type { EditorToolsDeps } from "./editorTools";

// The polygon editor's click, double-click and context-menu edits.
export function createEditActions({ viewportApi, onSolverStartMoved }: Pick<EditorToolsDeps, "viewportApi" | "onSolverStartMoved">, applyEditorTransition: (transition: EditorTransition) => void) {
  // How close (in screen pixels) a click must land to the first vertex to close
  // the region. A finger needs a more forgiving target than a mouse cursor.
  const CLOSE_HIT_RADIUS_PX = hasCoarsePointer() ? 24 : 12;

  const handleContextMenu = (event: MouseEvent) => {
    const state = getState();
    const canvasPoint = getCanvasFromClient(viewportApi, event.clientX, event.clientY);

    // right-clicking the start marker resets it to the solver default
    if (state.solverStartPoint && solverStartNearCanvasPoint(viewportApi, state, canvasPoint)) {
      swallow(event);
      setState({ solverStartPoint: null });
      onSolverStartMoved();
      return true;
    }

    const {
      geometry: { vertices: displayVertices },
    } = getEditorContext(state);
    const deleteIndex = findVertexNearCanvasPoint(viewportApi, canvasPoint, displayVertices);
    if (deleteIndex === -1) return false;

    swallow(event);
    applyEditorTransition(getEditorTransition(state, { kind: "delete-vertex", deleteIndex }));
    return true;
  };

  const handleDoubleClickAt = (clientX: number, clientY: number) => {
    const state = getState();
    const logicalMouse = getLogicalFromClient(viewportApi, clientX, clientY);
    const {
      geometry: { vertices: displayVertices, mode: displayMode },
    } = getEditorContext(state);
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

  const handleClick = (event: MouseEvent) => {
    const state = getState();
    if (state.clickFollowsDrag) {
      setState({ clickFollowsDrag: false });
      return;
    }

    // a click only sketches or places the objective; editing a finished region is drags and double-clicks
    const { session } = getEditorContext(state);
    if (session.kind !== "drafting" && session.kind !== "selecting-objective") return;
    const point = getLogicalFromClient(viewportApi, event.clientX, event.clientY);
    applyEditorTransition(getEditorTransition(state, { kind: "click", point, closeThreshold: worldDistanceForPixels(viewportApi, point, CLOSE_HIT_RADIUS_PX) }));
  };

  return { handleContextMenu, handleDoubleClickAt, handleClick };
}
