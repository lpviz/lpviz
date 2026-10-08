import { setCurrentMouse } from "@/features/core/currentMouse";
import { DEFAULT_Z_SCALE, getState, setState } from "@/features/core/store";
import type { HandleUndoRedo, SaveHistory } from "@/features/history/historyService";
import { getEditorContext, getEditorTransition } from "@/features/polytope-editor/editorSession";
import {
  EDGE_HIT_RADIUS_PX,
  findBoundaryRayNearPoint,
  findVertexNearLocalPoint,
  getLocalFromClient,
  getLogicalFromClient,
  solverStartNearLocalPoint,
  worldDistanceForPixels,
} from "@/features/polytope-editor/interactionState";
import { stepReplayDurationMs } from "@/features/solver/replayDuration";
import type { ViewportApi } from "@/features/viewport/runtime";
import { nearestEdge } from "@lpviz/math/polygon";
import type { Vec } from "@lpviz/math/types";
import { updatePanControls } from "./canvasDragActions";
import { swallow } from "./canvasGestures";

type EditActionDeps = {
  canvasManager: ViewportApi;
  saveHistory: SaveHistory;
  sendPolytope: () => void;
  handleUndoRedo: HandleUndoRedo;
  /** Re-solve the active solver after the start marker moved or reset. */
  onSolverStartMoved: () => void;
  showReplayDuration: (durationMs: number) => void;
  // the gesture layer's "this click is the synthetic one after a double tap"
  isClickSuppressed: () => boolean;
};

type ApplyEditorTransition = (transition: ReturnType<typeof getEditorTransition>) => void;

function createEditorTransitionApplier({ canvasManager, saveHistory, sendPolytope }: Pick<EditActionDeps, "canvasManager" | "saveHistory" | "sendPolytope">): ApplyEditorTransition {
  const commitEdit = (result: { vertices: Vec[]; completionMode: "draft" | "open" | "closed"; interiorPoint: Vec | null }) => {
    saveHistory();
    setState({
      vertices: result.vertices,
      completionMode: result.completionMode,
      interiorPoint: result.interiorPoint,
      polytope: null,
      inequalitiesMessage: null,
      highlightIndex: null,
    });
    canvasManager.draw();
    sendPolytope();
    updatePanControls(canvasManager);
  };

  return (transition) => {
    if (transition.kind === "reject-nonconvex") {
      // The problem panel's message slot (the same one that shows "Nonconvex");
      // the next accepted edit clears it. No blocking dialog.
      setState({ inequalitiesMessage: transition.reason });
      return;
    }

    if (transition.kind === "edit") {
      commitEdit(transition.result);
      return;
    }

    if (transition.kind === "select-objective") {
      saveHistory();
      setState({ objectiveVector: transition.objectiveVector });
      sendPolytope();
      canvasManager.draw();
      updatePanControls(canvasManager);
    }
  };
}

// click, double-click and context-menu edits
function createPointerEditActions(
  { canvasManager, onSolverStartMoved, isClickSuppressed }: Pick<EditActionDeps, "canvasManager" | "onSolverStartMoved" | "isClickSuppressed">,
  applyEditorTransition: ApplyEditorTransition,
) {
  // How close (in screen pixels) a click must land to the first vertex to close
  // the region. Touch needs a more forgiving target than a mouse cursor.
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const CLOSE_HIT_RADIUS_PX = coarsePointer ? 24 : 12;

  const handleContextMenu = (event: MouseEvent) => {
    const state = getState();
    if (state.isTransitioning3D) return;

    const local = getLocalFromClient(canvasManager, event.clientX, event.clientY);

    // right-clicking the start marker resets it to the solver default
    if (state.solverStartPoint && solverStartNearLocalPoint(canvasManager, state, local.x, local.y)) {
      swallow(event);
      setState({ solverStartPoint: null });
      onSolverStartMoved();
      canvasManager.draw();
      return;
    }

    const {
      geometry: { vertices: displayVertices },
    } = getEditorContext(state);
    const deleteIndex = findVertexNearLocalPoint(canvasManager, local.x, local.y, displayVertices);
    if (deleteIndex === -1) return;

    swallow(event);
    const deletion = getEditorTransition(state, {
      kind: "delete-vertex",
      deleteIndex,
    });
    applyEditorTransition(deletion);
  };

  const handleDoubleClickAt = (clientX: number, clientY: number) => {
    const state = getState();
    if (state.isTransitioning3D) return;

    const logicalMouse = getLogicalFromClient(canvasManager, clientX, clientY);
    const {
      geometry: { vertices: displayVertices, mode: displayMode },
    } = getEditorContext(state);
    const hullRepair = getEditorTransition(state, {
      kind: "repair-displayed-hull",
      point: logicalMouse,
    });
    if (hullRepair.kind !== "noop") {
      applyEditorTransition(hullRepair);
      return;
    }

    const edgeIndex = nearestEdge(displayVertices, logicalMouse, worldDistanceForPixels(canvasManager, logicalMouse, EDGE_HIT_RADIUS_PX), displayMode === "closed");
    if (edgeIndex !== null) {
      const insertion = getEditorTransition(state, {
        kind: "insert-edge-point",
        edgeIndex,
        point: logicalMouse,
      });
      if (insertion.kind !== "noop") {
        applyEditorTransition(insertion);
        return;
      }
    }

    const rayIndex = findBoundaryRayNearPoint(canvasManager, logicalMouse);
    if (rayIndex !== null) {
      const insertion = getEditorTransition(state, {
        kind: "insert-boundary-ray-point",
        rayIndex,
        point: logicalMouse,
      });
      if (insertion.kind !== "noop") {
        applyEditorTransition(insertion);
      }
    }
  };

  const handleClick = (event: MouseEvent) => {
    const state = getState();
    if (state.isTransitioning3D) return;
    if (isClickSuppressed()) {
      swallow(event);
      return;
    }

    if (state.lastCompletedInteraction !== "none") {
      setState({ lastCompletedInteraction: "none" });
      return;
    }

    const { session } = getEditorContext(state);
    const drawingPhase = session.kind === "drafting";
    const objectivePhase = session.kind === "selecting-objective";
    if (state.is3DMode && !drawingPhase && !objectivePhase) return;

    if (drawingPhase || objectivePhase) {
      const point = getLogicalFromClient(canvasManager, event.clientX, event.clientY);
      applyEditorTransition(
        getEditorTransition(state, {
          kind: "click",
          point,
          closeThreshold: worldDistanceForPixels(canvasManager, point, CLOSE_HIT_RADIUS_PX),
        }),
      );
    }
  };

  return { handleContextMenu, handleDoubleClickAt, handleClick };
}

// shift+wheel in 3D scales the z axis
const createWheelHandler = (canvasManager: ViewportApi) => (event: WheelEvent) => {
  const { is3DMode, isTransitioning3D, zScale } = getState();
  if (!is3DMode || isTransitioning3D || !event.shiftKey) return;

  swallow(event);

  const zoomFactor = 1.05;
  const dominantDelta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (dominantDelta === 0) return;

  const effectiveScale = (zScale || DEFAULT_Z_SCALE) * (dominantDelta < 0 ? 1 / zoomFactor : zoomFactor);
  const clampedScale = Math.max(0.01, Math.min(100, effectiveScale));
  setState({ zScale: clampedScale });
  canvasManager.draw();
};

const isTextEntryTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

function createKeyDownHandler(
  { canvasManager, handleUndoRedo, showReplayDuration }: Pick<EditActionDeps, "canvasManager" | "handleUndoRedo" | "showReplayDuration">,
  applyEditorTransition: ApplyEditorTransition,
) {
  const finishOpenRegion = () => {
    // finish-open yields noop, reject-nonconvex or edit; only an edit clears
    // the sketch cursor and hands the canvas back to panning
    const finishResult = getEditorTransition(getState(), { kind: "finish-open" });
    applyEditorTransition(finishResult);
    if (finishResult.kind !== "edit") return;
    setCurrentMouse(null);
    canvasManager.set2DPanEnabled(true);
  };

  // "+" lengthens the replay, "-" shortens it; the readout shows on every press, including one
  // that hits an end of the range, so the keys never feel dead
  const adjustReplayDuration = (direction: 1 | -1) => {
    const { solverSettings } = getState();
    const replaySpeed = stepReplayDurationMs(solverSettings.replaySpeed, direction);
    if (replaySpeed !== solverSettings.replaySpeed) {
      setState({ solverSettings: { ...solverSettings, replaySpeed } });
    }
    showReplayDuration(replaySpeed);
  };

  return (event: KeyboardEvent) => {
    // this is a window-level capture handler; typing in form fields must not
    // trigger canvas shortcuts (or block native text-editing undo)
    if (isTextEntryTarget(event.target)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      handleUndoRedo(event.shiftKey);
    }
    if (event.key === "Enter") {
      // let a focused button or link activate natively
      if (event.target instanceof HTMLElement && event.target.closest("button, a, [role='button']")) {
        return;
      }
      event.preventDefault();
      finishOpenRegion();
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() === "s") {
      const { snapToGrid } = getState();
      setState({ snapToGrid: !snapToGrid });
    }
    if (event.key.toLowerCase() === "h") {
      const { objectiveHidden } = getState();
      setState({ objectiveHidden: !objectiveHidden });
      canvasManager.draw();
    }
    // "=" and "_" are the unshifted/shifted twins of "+" and "-", so both
    // layouts of each key work. Checked after the modifier guard above so
    // ctrl/cmd +/- stays browser zoom.
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      adjustReplayDuration(1);
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      adjustReplayDuration(-1);
    }
  };
}

// The editor's non-drag actions: applying editor transitions, the click /
// double-click / context-menu edits, the z-scale wheel and the keyboard
// shortcuts.
export function createEditActions(deps: EditActionDeps) {
  const applyEditorTransition = createEditorTransitionApplier(deps);
  return {
    ...createPointerEditActions(deps, applyEditorTransition),
    handleWheel: createWheelHandler(deps.canvasManager),
    handleKeyDown: createKeyDownHandler(deps, applyEditorTransition),
  };
}
