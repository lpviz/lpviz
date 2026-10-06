import { setCurrentMouse } from "@/features/core/currentMouse";
import { DEFAULT_Z_SCALE, computeDrawingPhase, getState, setState, type DragTarget, type DrawingPhase, type EditorInteractionState, type HistoryEntry, type State } from "@/features/core/store";
import type { HandleUndoRedo, SaveHistory } from "@/features/history/historyService";
import { getEditorContext, getEditorTransition } from "@/features/polytope-editor/editorSession";
import {
  EDGE_HIT_RADIUS_PX,
  exceedsDragThreshold,
  findBoundaryRayNearPoint,
  findEdgeNearPoint,
  findVertexNearLocalPoint,
  getDragStartTarget,
  getLocalFromClient,
  getLogicalFromClient,
  solverStartNearLocalPoint,
  worldDistanceForPixels,
  type ConstraintDragTarget,
} from "@/features/polytope-editor/interactionState";
import { stepReplayDurationMs } from "@/features/solver/replayDuration";
import type { ViewportApi } from "@/features/viewport/runtime";
import { verticesFromLines } from "@lpviz/math/geometry";
import type { PointXY } from "@lpviz/math/types";

const DRAG_COMPLETION: Record<DragTarget["kind"], State["lastCompletedInteraction"]> = {
  point: "dragged-point",
  constraint: "dragged-constraint",
  "solver-start": "dragged-start",
  objective: "dragged-objective",
};

export function attachCanvasInteractions({
  canvasManager,
  saveHistory,
  sendPolytope,
  handleUndoRedo,
  onSolverStartMoved,
  showReplayDuration,
}: {
  canvasManager: ViewportApi;
  saveHistory: SaveHistory;
  sendPolytope: () => void;
  handleUndoRedo: HandleUndoRedo;
  /** Re-solve the active solver after the start marker moved or reset. */
  onSolverStartMoved: () => void;
  showReplayDuration: (durationMs: number) => void;
}): () => void {
  let pendingDragHistory: HistoryEntry | null = null;
  let lastTap: {
    time: number;
    clientX: number;
    clientY: number;
  } | null = null;
  let activeTouchStart: {
    clientX: number;
    clientY: number;
    moved: boolean;
  } | null = null;
  let activePenStart: {
    pointerId: number;
    clientX: number;
    clientY: number;
    moved: boolean;
  } | null = null;
  let suppressClickUntil = 0;
  const canvas = canvasManager.getCanvasElement();
  const cleanupHandlers: Array<() => void> = [];
  const DOUBLE_TAP_MS = 350;
  const DOUBLE_TAP_RADIUS_PX = 28;
  // How close (in screen pixels) a click must land to the first vertex to close
  // the region. Touch needs a more forgiving target than a mouse cursor.
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const CLOSE_HIT_RADIUS_PX = coarsePointer ? 24 : 12;

  // pen and touch share the same "has this gesture drifted far enough to be a
  // drag rather than a tap" test, latched onto the gesture's start record
  const markIfMovedBeyondTap = (start: { clientX: number; clientY: number; moved: boolean }, clientX: number, clientY: number) => {
    start.moved = start.moved || Math.hypot(clientX - start.clientX, clientY - start.clientY) > DOUBLE_TAP_RADIUS_PX;
  };

  const bindEvent = (target: EventTarget, eventName: string, handler: (event: never) => void, options?: boolean | AddEventListenerOptions) => {
    const listener = handler as EventListener;
    target.addEventListener(eventName, listener, options);
    cleanupHandlers.push(() => target.removeEventListener(eventName, listener, options));
  };

  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const captureHistoryEntry = (state: Pick<State, "vertices" | "objectiveVector" | "completionMode">): HistoryEntry => ({
    vertices: state.vertices.map((v) => ({ x: v.x, y: v.y })),
    objectiveVector: state.objectiveVector ? { ...state.objectiveVector } : null,
    completionMode: state.completionMode,
  });

  const persistPendingDragHistory = () => {
    if (!pendingDragHistory) return;
    saveHistory(pendingDragHistory);
    pendingDragHistory = null;
  };

  const updatePanControls = () => {
    canvasManager.set2DPanEnabled(computeDrawingPhase(getState()) === "ready_for_solvers");
  };

  const restoreViewportControls = () => {
    canvasManager.setControlsBlocked(false);
    updatePanControls();
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

  const commitEdit = (result: { vertices: PointXY[]; completionMode: "draft" | "open" | "closed"; interiorPoint: PointXY | null }) => {
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
    updatePanControls();
  };

  const applyEditorTransition = (transition: ReturnType<typeof getEditorTransition>) => {
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
      updatePanControls();
    }
  };

  const applyConstraintDrag = (target: ConstraintDragTarget, logicalCoords: PointXY) => {
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

  const applyDraggingInteraction = (interaction: Extract<EditorInteractionState, { kind: "dragging" }>, logicalCoords: PointXY) => {
    persistPendingDragHistory();
    const dragTarget = interaction.target;
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
      applyConstraintDrag(dragTarget, logicalCoords);
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

  const updatePointerPreview = (phase: DrawingPhase, logicalCoords: PointXY) => {
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

    updatePointerPreview(phaseSnapshot, logicalCoords);
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

  const handlePointerRelease = (event: MouseEvent | TouchEvent | PointerEvent) => {
    if (getState().isTransitioning3D) return;

    const interactionBeforeEnd = getState();
    handleDragEnd();
    if (interactionBeforeEnd.editorInteraction.kind !== "idle") swallow(event);
  };

  const stopBlockedPointerEvent = (event: MouseEvent | TouchEvent | PointerEvent) => {
    if (getState().editorInteraction.kind !== "idle") swallow(event);
  };

  const handlePointerStart = (clientX: number, clientY: number, event: MouseEvent | TouchEvent | PointerEvent) => {
    if (getState().isTransitioning3D) return;
    if (handleDragStart(clientX, clientY)) swallow(event);
  };

  const handlePointerMove = (clientX: number, clientY: number, event: MouseEvent | TouchEvent | PointerEvent) => {
    const state = getState();
    if (state.isTransitioning3D || (state.isNavigatingViewport && state.editorInteraction.kind === "idle")) {
      return;
    }
    handleDragMove(clientX, clientY);
    stopBlockedPointerEvent(event);
  };

  const handleWindowPointerEnd = (event: MouseEvent | TouchEvent | PointerEvent) => {
    if (event.target === canvas) return;
    if (getState().editorInteraction.kind === "idle") return;
    handlePointerRelease(event);
  };

  const finishOpenRegion = () => {
    // finish-open yields noop, reject-nonconvex or edit; only an edit clears
    // the sketch cursor and hands the canvas back to panning
    const finishResult = getEditorTransition(getState(), { kind: "finish-open" });
    applyEditorTransition(finishResult);
    if (finishResult.kind !== "edit") return;
    setCurrentMouse(null);
    canvasManager.set2DPanEnabled(true);
  };

  const handleWheel = (event: WheelEvent) => {
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

    const edgeIndex = findEdgeNearPoint(logicalMouse, displayVertices, displayMode, worldDistanceForPixels(canvasManager, logicalMouse, EDGE_HIT_RADIUS_PX));
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
        point: { x: logicalMouse.x, y: logicalMouse.y },
      });
      if (insertion.kind !== "noop") {
        applyEditorTransition(insertion);
      }
    }
  };

  const registerTap = (clientX: number, clientY: number) => {
    const now = performance.now();
    if (lastTap && now - lastTap.time <= DOUBLE_TAP_MS && Math.hypot(clientX - lastTap.clientX, clientY - lastTap.clientY) <= DOUBLE_TAP_RADIUS_PX) {
      lastTap = null;
      suppressClickUntil = now + DOUBLE_TAP_MS;
      handleDoubleClickAt(clientX, clientY);
      return true;
    }

    lastTap = { time: now, clientX, clientY };
    return false;
  };

  // The shared tail of a pen pointerup and a touchend: only a gesture that neither drifted nor
  // dragged is tested for a double tap, and the event is swallowed when it was one.
  const endTapGesture = (event: PointerEvent | TouchEvent, started: { moved: boolean } | null, forget: () => void, at: { clientX: number; clientY: number } | undefined) => {
    const interactionBeforeEnd = getState().editorInteraction;
    handlePointerRelease(event);
    forget();
    if (!at || !started || started.moved || interactionBeforeEnd.kind === "dragging") return;
    if (registerTap(at.clientX, at.clientY)) swallow(event);
  };

  const handleClick = (event: MouseEvent) => {
    const state = getState();
    if (state.isTransitioning3D) return;
    if (performance.now() < suppressClickUntil) {
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

  const isTextEntryTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

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

  const handleKeyDown = (event: KeyboardEvent) => {
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

  updatePanControls();

  bindEvent(
    canvas,
    "mousedown",
    (event: MouseEvent) => {
      if (event.button !== 0) return;
      handlePointerStart(event.clientX, event.clientY, event);
    },
    { capture: true },
  );
  bindEvent(
    canvas,
    "mousemove",
    (event: MouseEvent) => {
      handlePointerMove(event.clientX, event.clientY, event);
    },
    { capture: true },
  );
  bindEvent(
    canvas,
    "mouseup",
    (event: MouseEvent) => {
      if (event.button !== 0) return;
      handlePointerRelease(event);
    },
    { capture: true },
  );
  bindEvent(
    canvas,
    "pointerdown",
    (event: PointerEvent) => {
      if (event.pointerType !== "pen" || !event.isPrimary || event.button !== 0) {
        return;
      }
      activePenStart = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        moved: false,
      };
      // Without capture, lifting the pen outside the canvas delivers
      // pointerup elsewhere (and preventDefault suppresses the compat
      // mouseup fallback), leaving the editor stuck in "dragging".
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // pointer may already be gone
      }
      handlePointerStart(event.clientX, event.clientY, event);
    },
    { capture: true },
  );
  bindEvent(
    canvas,
    "pointermove",
    (event: PointerEvent) => {
      if (event.pointerType !== "pen" || !activePenStart || activePenStart.pointerId !== event.pointerId) {
        return;
      }
      markIfMovedBeyondTap(activePenStart, event.clientX, event.clientY);
      handlePointerMove(event.clientX, event.clientY, event);
    },
    { capture: true },
  );
  bindEvent(
    canvas,
    "pointerup",
    (event: PointerEvent) => {
      if (event.pointerType !== "pen" || !activePenStart || activePenStart.pointerId !== event.pointerId) {
        return;
      }
      endTapGesture(event, activePenStart, () => (activePenStart = null), event);
    },
    { capture: true },
  );
  bindEvent(
    canvas,
    "pointercancel",
    (event: PointerEvent) => {
      if (activePenStart?.pointerId === event.pointerId) {
        // end the drag like pointerup would, or the editor stays "dragging"
        // with the viewport controls blocked
        handlePointerRelease(event);
        activePenStart = null;
      }
    },
    { capture: true },
  );
  bindEvent(
    canvas,
    "touchstart",
    (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      activeTouchStart = {
        clientX: touch.clientX,
        clientY: touch.clientY,
        moved: false,
      };
      handlePointerStart(touch.clientX, touch.clientY, event);
    },
    { passive: false, capture: true },
  );
  bindEvent(
    canvas,
    "touchmove",
    (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      if (activeTouchStart) {
        markIfMovedBeyondTap(activeTouchStart, touch.clientX, touch.clientY);
      }
      handlePointerMove(touch.clientX, touch.clientY, event);
    },
    { passive: false, capture: true },
  );
  bindEvent(
    canvas,
    "touchend",
    (event: TouchEvent) => {
      endTapGesture(event, activeTouchStart, () => (activeTouchStart = null), event.changedTouches[0]);
    },
    { passive: false, capture: true },
  );
  bindEvent(
    window,
    "mouseup",
    (event: MouseEvent) => {
      if (event.button !== 0) return;
      handleWindowPointerEnd(event);
    },
    { capture: true },
  );
  bindEvent(window, "touchend", (event: TouchEvent) => handleWindowPointerEnd(event), { passive: false, capture: true });
  bindEvent(window, "keydown", handleKeyDown, { capture: true });
  bindEvent(canvas, "wheel", handleWheel, { passive: false, capture: true });
  bindEvent(canvas, "contextmenu", handleContextMenu, { capture: true });
  bindEvent(canvas, "dblclick", (event: MouseEvent) => handleDoubleClickAt(event.clientX, event.clientY));
  bindEvent(canvas, "click", handleClick);

  return () => {
    cleanupDragState();
    while (cleanupHandlers.length > 0) cleanupHandlers.pop()?.();
  };
}
