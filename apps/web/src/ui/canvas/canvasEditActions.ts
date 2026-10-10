import { setCurrentMouse } from "@/features/core/currentMouse";
import { getState, setState } from "@/features/core/store";
import { type EditorTransition, getEditorContext, getEditorTransition } from "@/features/polytope-editor/editorSession";
import {
  EDGE_HIT_RADIUS_PX,
  findBoundaryRayNearPoint,
  findVertexNearLocalPoint,
  getLocalFromClient,
  getLogicalFromClient,
  solverStartNearLocalPoint,
  worldDistanceForPixels,
} from "@/features/polytope-editor/hitTesting";
import { stepReplayDurationMs } from "@/features/solver/replayDuration";
import { nearestEdge } from "@lpviz/math/polygon";
import { clampZScale, DEFAULT_Z_SCALE } from "@lpviz/viewport/defaults";
import { updatePanControls } from "./canvasDragActions";
import { swallow } from "./canvasGestures";
import type { EditorToolsDeps } from "./editorTools";

type ApplyEditorTransition = (transition: EditorTransition) => void;

// Every accepted edit is its own undoable step; the derived polytope is cleared for the re-derive.
function createEditorTransitionApplier({ viewportApi, saveHistory, sendPolytope }: Pick<EditorToolsDeps, "viewportApi" | "saveHistory" | "sendPolytope">): ApplyEditorTransition {
  return (transition) => {
    if (transition.kind === "reject-nonconvex") {
      // The problem panel's message slot (the same one that shows "Nonconvex");
      // the next accepted edit clears it. No blocking dialog.
      setState({ inequalitiesMessage: transition.reason });
      return;
    }

    if (transition.kind === "edit") {
      saveHistory();
      setState({ ...transition.result, polytope: null, inequalitiesMessage: null, highlightIndex: null });
      sendPolytope();
      updatePanControls(viewportApi);
      return;
    }

    if (transition.kind === "select-objective") {
      saveHistory();
      setState({ objectiveVector: transition.objectiveVector });
      sendPolytope();
      updatePanControls(viewportApi);
    }
  };
}

// click, double-click and context-menu edits
function createPointerEditActions(
  { viewportApi, onSolverStartMoved, isClickSuppressed }: Pick<EditorToolsDeps, "viewportApi" | "onSolverStartMoved" | "isClickSuppressed">,
  applyEditorTransition: ApplyEditorTransition,
) {
  // How close (in screen pixels) a click must land to the first vertex to close
  // the region. Touch needs a more forgiving target than a mouse cursor.
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const CLOSE_HIT_RADIUS_PX = coarsePointer ? 24 : 12;

  const handleContextMenu = (event: MouseEvent) => {
    const state = getState();
    if (state.isTransitioning3D) return;

    const local = getLocalFromClient(viewportApi, event.clientX, event.clientY);

    // right-clicking the start marker resets it to the solver default
    if (state.solverStartPoint && solverStartNearLocalPoint(viewportApi, state, local.x, local.y)) {
      swallow(event);
      setState({ solverStartPoint: null });
      onSolverStartMoved();
      return;
    }

    const {
      geometry: { vertices: displayVertices },
    } = getEditorContext(state);
    const deleteIndex = findVertexNearLocalPoint(viewportApi, local.x, local.y, displayVertices);
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

    const logicalMouse = getLogicalFromClient(viewportApi, clientX, clientY);
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

    const edgeIndex = nearestEdge(displayVertices, logicalMouse, worldDistanceForPixels(viewportApi, logicalMouse, EDGE_HIT_RADIUS_PX), displayMode === "closed");
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

    const rayIndex = findBoundaryRayNearPoint(viewportApi, state, logicalMouse);
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

    // a click only sketches or places the objective; editing a finished region is drags and double-clicks
    const { session } = getEditorContext(state);
    if (session.kind !== "drafting" && session.kind !== "selecting-objective") return;
    const point = getLogicalFromClient(viewportApi, event.clientX, event.clientY);
    applyEditorTransition(getEditorTransition(state, { kind: "click", point, closeThreshold: worldDistanceForPixels(viewportApi, point, CLOSE_HIT_RADIUS_PX) }));
  };

  return { handleContextMenu, handleDoubleClickAt, handleClick };
}

// shift+wheel in 3D scales the z axis
const handleWheel = (event: WheelEvent) => {
  const { is3DMode, isTransitioning3D, zScale } = getState();
  if (!is3DMode || isTransitioning3D || !event.shiftKey) return;

  swallow(event);

  const zoomFactor = 1.05;
  const dominantDelta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (dominantDelta === 0) return;

  const effectiveScale = (zScale || DEFAULT_Z_SCALE) * (dominantDelta < 0 ? 1 / zoomFactor : zoomFactor);
  setState({ zScale: clampZScale(effectiveScale) });
};

const isTextEntryTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

function createKeyDownHandler(
  { viewportApi, handleUndoRedo, showReplayDuration }: Pick<EditorToolsDeps, "viewportApi" | "handleUndoRedo" | "showReplayDuration">,
  applyEditorTransition: ApplyEditorTransition,
) {
  const finishOpenRegion = () => {
    // finish-open yields noop, reject-nonconvex or edit; only an edit clears
    // the sketch cursor and hands the canvas back to panning
    const finishResult = getEditorTransition(getState(), { kind: "finish-open" });
    applyEditorTransition(finishResult);
    if (finishResult.kind !== "edit") return;
    setCurrentMouse(null);
    viewportApi.set2DPanEnabled(true);
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
export function createEditActions(deps: EditorToolsDeps) {
  const applyEditorTransition = createEditorTransitionApplier(deps);
  return {
    ...createPointerEditActions(deps, applyEditorTransition),
    handleWheel,
    handleKeyDown: createKeyDownHandler(deps, applyEditorTransition),
  };
}
