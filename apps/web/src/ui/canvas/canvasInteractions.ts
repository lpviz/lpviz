import { setCurrentMouse } from "@/features/core/currentMouse";
import {
  DEFAULT_Z_SCALE,
  computeDrawingPhase,
  getState,
  setState,
  type DrawingPhase,
  type EditorInteractionState,
  type HistoryEntry,
  type State,
} from "@/features/core/store";
import type {
  HandleUndoRedo,
  SaveHistory,
} from "@/features/history/historyService";
import {
  getEditorContext,
  getEditorTransition,
} from "@/features/polytope-editor/editorSession";
import {
  exceedsDragThreshold,
  findBoundaryRayNearPoint,
  findEdgeNearPoint,
  findVertexNearLocalPoint,
  getDragStartTarget,
  getLocalFromClient,
  getLogicalFromClient,
  solverStartNearLocalPoint,
  type ConstraintDragTarget,
} from "@/features/polytope-editor/interactionState";
import { stepReplayDurationMs } from "@/features/solver/replayDuration";
import { applyEdgeBevel, applyFaceOffsetDrag, applyFaceRemoval, applyVertexChamfer, baseCentroidForSketch, commitExtrusion, commitObjective3, currentEdges3, deleteVertex3, insertVertex3, MIN_EXTRUDE_HEIGHT, moveVertex3, objectiveAnchor3, setObjectiveVector3 } from "@/features/polytope-editor/editor3";
import { constrainedPointFromPointer, faceOffsetFromPointer, findEdge3NearClient, findFaceAtClient, findVertex3NearClient, heightFromPointer, isExtrudeHandleAtClient, isObjective3TipAtClient, objectivePointFromPointer } from "@/features/polytope-editor/interaction3";
import { collectZoomFitBounds } from "@/features/viewport/bounds";
import type { ViewportApi } from "@/features/viewport/runtime";
import { verticesFromLines } from "@lpviz/math/geometry";
import type { PointXY, PointXYZ } from "@lpviz/math/types";

// Camera pans/orbits also end in a click; ignore clicks whose pointer
// travelled further than this (the editor's own drags are suppressed via
// lastCompletedInteraction, which camera gestures never set).
const CLICK_MOVE_TOLERANCE_PX = 5;

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

  const setCanvasCursor = (cursor: string) => {
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  };

  const maybeSnapPoint3 = (point: PointXYZ): PointXYZ => (getState().snapToGrid ? { x: Math.round(point.x), y: Math.round(point.y), z: Math.round(point.z) } : point);

  // frame the solid after big shape changes (extrude commit) so it never
  // towers out of the viewport
  const fitSolidInView = () => {
    const zoomFit = collectZoomFitBounds(getState());
    if (zoomFit) canvasManager.zoomToFit(zoomFit.bounds, 50, zoomFit.zBounds);
  };
  const DOUBLE_TAP_MS = 350;
  const DOUBLE_TAP_RADIUS_PX = 28;
  // How close (in screen pixels) a click must land to the first vertex to close
  // the region. Touch needs a more forgiving target than a mouse cursor.
  const coarsePointer = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  const CLOSE_HIT_RADIUS_PX = coarsePointer ? 24 : 12;

  // The editor's close test is in world units; convert the pixel radius to a
  // world distance at `worldPoint` so it stays constant on screen across zoom
  // levels (a fixed world threshold becomes an unhittable target when zoomed
  // out, which is the usual case on mobile).
  const worldDistanceForPixels = (worldPoint: PointXY, pixels: number) => {
    const canvasPoint = canvasManager.toCanvasCoords(worldPoint.x, worldPoint.y);
    const shifted = canvasManager.toLogicalCoords(canvasPoint.x + pixels, canvasPoint.y);
    return Math.hypot(shifted.x - worldPoint.x, shifted.y - worldPoint.y);
  };

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

  const captureHistoryEntry = (state: Pick<State, "vertices" | "objectiveVector" | "completionMode" | "problemMode" | "vertices3" | "objectiveVector3" | "editor3Phase">): HistoryEntry => ({
    vertices: state.vertices.map((v) => ({ x: v.x, y: v.y })),
    objectiveVector: state.objectiveVector ? { ...state.objectiveVector } : null,
    completionMode: state.completionMode,
    ...(state.problemMode === "3d"
      ? {
          vertices3: state.vertices3.map((v) => ({ ...v })),
          objectiveVector3: state.objectiveVector3 ? { ...state.objectiveVector3 } : null,
          editor3Phase: state.editor3Phase,
        }
      : {}),
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
    setCanvasCursor("");
    setState(
      {
        editorInteraction: { kind: "idle" },
        lastCompletedInteraction: "none",
      },
      { viewportDirty: {} },
    );
    restoreViewportControls();
    requestAnimationFrame(restoreViewportControls);
  };

  const commitEdit = (
    result: {
      vertices: PointXY[];
      completionMode: "draft" | "open" | "closed";
      interiorPoint: PointXY | null;
    },
    options: {
      saveToHistory?: boolean;
      extraPatch?: Partial<State>;
    } = {},
  ) => {
    if (options.saveToHistory ?? true) {
      saveHistory();
    }
    const state3D = getState();
    // Closing the base sketch in 3D problem mode advances the CAD flow to the
    // extrude phase (the prism planes are built from the closed polygon's
    // 2D H-rep, which sendPolytope() computes below).
    const advanceToExtrude = state3D.problemMode === "3d" && state3D.editor3Phase === "sketch" && result.completionMode === "closed";
    setState({
      vertices: result.vertices,
      completionMode: result.completionMode,
      interiorPoint: result.interiorPoint,
      polytope: null as null,
      inequalitiesMessage: null,
      highlightIndex: null,
      ...(advanceToExtrude ? { editor3Phase: "extrude" as const, extrudePreviewHeight: null } : {}),
      ...(options.extraPatch ?? {}),
    });
    if (advanceToExtrude) setCurrentMouse(null);
    canvasManager.draw();
    sendPolytope();
    updatePanControls();
  };

  const applyEditorTransition = (transition: ReturnType<typeof getEditorTransition>) => {
    if (transition.kind === "reject-nonconvex") {
      alert(transition.reason);
      return;
    }

    if (transition.kind === "edit") {
      commitEdit(transition.result, {
        saveToHistory: transition.saveToHistory,
      });
      return;
    }

    if (transition.kind === "select-objective") {
      if (transition.saveToHistory) {
        saveHistory();
      }
      setState({ objectiveVector: transition.objectiveVector });
      sendPolytope();
      canvasManager.draw();
      updatePanControls();
    }
  };

  const applyConstraintDrag = (target: ConstraintDragTarget, logicalCoords: PointXY) => {
    const delta = (logicalCoords.x - target.start.x) * target.normal.x + (logicalCoords.y - target.start.y) * target.normal.y;

    if (target.operation.kind === "closed-line") {
      const line = target.operation.lines[target.operation.lineIndex];
      const length = Math.hypot(line[0], line[1]);
      if (length <= 0) return;

      const shift = delta * length;
      const updatedLines = target.operation.lines.slice();
      updatedLines[target.operation.lineIndex] = [line[0], line[1], line[2] + shift];
      const updatedVertices = verticesFromLines(updatedLines);
      if (updatedVertices.length < 2) return;

      setState({ vertices: updatedVertices.map(([x, y]) => ({ x, y })) });

      setState(
        {
          editorInteraction: {
            kind: "dragging",
            target: {
              kind: "constraint",
              operation: {
                kind: "closed-line",
                lineIndex: target.operation.lineIndex,
                lines: updatedLines,
              },
              start: logicalCoords,
              normal: target.normal,
            },
          },
        },
        { viewportDirty: {} },
      );
    } else {
      const operation = target.operation;
      const shiftX = target.normal.x * delta;
      const shiftY = target.normal.y * delta;
      const indices = new Set(operation.vertexIndices);
      setState({
        vertices: getState().vertices.map((v, i) => (indices.has(i) ? { x: v.x + shiftX, y: v.y + shiftY } : v)),
      });
      setState(
        {
          editorInteraction: {
            kind: "dragging",
            target: {
              kind: "constraint",
              operation,
              start: logicalCoords,
              normal: target.normal,
            },
          },
        },
        { viewportDirty: {} },
      );
    }

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
        solverStartPoint: off
          ? { x: logicalCoords.x + off.x, y: logicalCoords.y + off.y }
          : logicalCoords,
      });
      onSolverStartMoved();
      canvasManager.draw();
      return;
    }

    setState(
      { objectiveVector: logicalCoords },
    );
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

  // world position of the objective arrow's tip (anchored at the solid's centroid)
  const objective3Tip = (state: State): PointXYZ => {
    const anchor = objectiveAnchor3();
    const vector = state.objectiveVector3 ?? { x: 0, y: 0, z: 0 };
    return { x: anchor.x + vector.x, y: anchor.y + vector.y, z: anchor.z + vector.z };
  };

  // A vertex that is not a hull corner but lies on a face (just inserted via
  // double-click) drags along that face's outward normal; hull corners drag
  // freely on the camera plane.
  const faceNormalAxisForHandle = (state: State, vertexIndex: number): PointXYZ | undefined => {
    const rep = state.polytope3;
    if (!rep || rep.kind !== "bounded") return undefined;
    if (rep.faces.some((face) => face.vertexIndices.includes(vertexIndex))) return undefined;
    const v = rep.vertices[vertexIndex]!;
    for (const face of rep.faces) {
      const plane = rep.planes[face.planeIndex]!;
      if (Math.abs(plane[0]! * v.x + plane[1]! * v.y + plane[2]! * v.z - plane[3]!) < 1e-6 * (1 + Math.abs(plane[3]!))) {
        return { x: plane[0]!, y: plane[1]!, z: plane[2]! };
      }
    }
    return undefined;
  };

  const getDragStartTarget3D = (state: State, clientX: number, clientY: number) => {
    if (state.editor3Phase === "extrude") {
      const base = baseCentroidForSketch();
      if (base && isExtrudeHandleAtClient(canvasManager, base, state.extrudePreviewHeight ?? 0, clientX, clientY)) {
        return { kind: "extrude-handle" } as const;
      }
      return null;
    }
    if (state.editor3Phase === "ready") {
      if (state.objectiveVector3 && !state.objectiveHidden && isObjective3TipAtClient(canvasManager, objective3Tip(state), clientX, clientY)) {
        return { kind: "objective3" } as const;
      }
      const vertexIndex = findVertex3NearClient(canvasManager, state.vertices3, clientX, clientY);
      if (vertexIndex >= 0) {
        return {
          kind: "vertex3",
          index: vertexIndex,
          anchor: { ...state.vertices3[vertexIndex]! },
          axis: faceNormalAxisForHandle(state, vertexIndex),
        } as const;
      }
      const pick = findFaceAtClient(canvasManager, state, clientX, clientY);
      if (pick) {
        const plane = state.planes[pick.planeIndex]!;
        return {
          kind: "face3",
          anchorPoint: pick.point,
          normal: { x: plane[0]!, y: plane[1]!, z: plane[2]! },
          anchorD: plane[3]!,
        } as const;
      }
    }
    return null;
  };

  const handleDragStart = (clientX: number, clientY: number): boolean => {
    const state = getState();
    // In 3D problem mode only the sketch phase reuses the 2D editor's drag
    // targets (base vertices on the ground plane); everything later is a
    // handle/face/objective-tip drag that starts immediately.
    if (state.problemMode === "3d" && state.editor3Phase !== "sketch") {
      const target3D = getDragStartTarget3D(state, clientX, clientY);
      if (!target3D) return false;
      pendingDragHistory = captureHistoryEntry(state);
      setState(
        {
          editorInteraction: { kind: "dragging", target: target3D },
          // hull re-derivation reorders planes during face/vertex drags, so
          // any hover highlight index would go stale mid-drag
          ...(target3D.kind === "face3" || target3D.kind === "vertex3" ? { hoveredFaceIndex: null } : {}),
        },
        { viewportDirty: {} },
      );
      canvasManager.setControlsBlocked(true);
      return true;
    }
    const target = getDragStartTarget(canvasManager, state, clientX, clientY);
    if (!target) return false;

    if (target.kind === "objective" || target.kind === "solver-start") {
      // the start marker is not part of the drawing, so it never enters the
      // undo history
      if (target.kind === "objective") {
        pendingDragHistory = captureHistoryEntry(state);
      }
      setState(
        {
          editorInteraction: { kind: "dragging", target },
        },
        { viewportDirty: {} },
      );
      canvasManager.setControlsBlocked(true);
      return true;
    }
    // the 2D hit-tester never yields 3D targets; narrow for pending-drag
    if (target.kind !== "point" && target.kind !== "constraint") return false;

    setState(
      {
        editorInteraction: {
          kind: "pending-drag",
          target,
          dragStartPos: { x: clientX, y: clientY },
        },
        lastCompletedInteraction: "none",
      },
      { viewportDirty: {} },
    );
    pendingDragHistory = captureHistoryEntry(state);
    if (target.kind === "point") {
      canvasManager.setControlsBlocked(true);
    }
    return true;
  };

  const applyDragging3D = (target: Extract<State["editorInteraction"], { kind: "dragging" }>["target"], clientX: number, clientY: number) => {
    persistPendingDragHistory();
    if (target.kind === "extrude-handle") {
      const base = baseCentroidForSketch();
      if (!base) return;
      const rawHeight = heightFromPointer(canvasManager, base, clientX, clientY);
      if (rawHeight === null) return;
      const height = getState().snapToGrid ? Math.round(rawHeight) : rawHeight;
      setState({ extrudePreviewHeight: height });
      canvasManager.draw();
      return;
    }
    if (target.kind === "face3") {
      const targetD = faceOffsetFromPointer(canvasManager, target.anchorPoint, target.normal, target.anchorD, clientX, clientY);
      if (targetD === null) return;
      applyFaceOffsetDrag(target.normal, targetD);
      canvasManager.draw();
      return;
    }
    if (target.kind === "vertex3") {
      const point = target.axis ? constrainedPointFromPointer(canvasManager, target.anchor, target.axis, clientX, clientY) : objectivePointFromPointer(canvasManager, target.anchor, clientX, clientY);
      if (!point) return;
      moveVertex3(target.index, maybeSnapPoint3(point));
      canvasManager.draw();
      return;
    }
    if (target.kind === "objective3") {
      const anchor = objectiveAnchor3();
      const currentVector = getState().objectiveVector3 ?? { x: 0, y: 0, z: 0 };
      const tip: PointXYZ = { x: anchor.x + currentVector.x, y: anchor.y + currentVector.y, z: anchor.z + currentVector.z };
      const point = objectivePointFromPointer(canvasManager, tip, clientX, clientY);
      if (!point) return;
      setObjectiveVector3(maybeSnapPoint3({ x: point.x - anchor.x, y: point.y - anchor.y, z: point.z - anchor.z }));
      canvasManager.draw();
    }
  };

  // All pointer-move behavior past the sketch phase in 3D problem mode:
  // handle/face/objective drags, the objective preview, and face hover.
  // Returns false only when the 2D editor should take over (sketch phase).
  const handleDragMove3D = (state: State, clientX: number, clientY: number): boolean => {
    if (state.editor3Phase === "sketch") {
      setCanvasCursor("crosshair");
      return false;
    }
    const interaction = state.editorInteraction;
    if (interaction.kind === "dragging" && (interaction.target.kind === "extrude-handle" || interaction.target.kind === "face3" || interaction.target.kind === "vertex3" || interaction.target.kind === "objective3")) {
      setCanvasCursor("grabbing");
      applyDragging3D(interaction.target, clientX, clientY);
      return true;
    }
    if (interaction.kind !== "idle") return true;
    if (state.editor3Phase === "extrude") {
      const base = baseCentroidForSketch();
      const overHandle = base !== null && isExtrudeHandleAtClient(canvasManager, base, state.extrudePreviewHeight ?? 0, clientX, clientY);
      setCanvasCursor(overHandle ? "ns-resize" : "");
      return true;
    }
    if (state.editor3Phase === "objective") {
      setCanvasCursor("crosshair");
      const anchor = objectiveAnchor3();
      const point = objectivePointFromPointer(canvasManager, anchor, clientX, clientY);
      if (point) {
        setState({ currentObjective3: maybeSnapPoint3({ x: point.x - anchor.x, y: point.y - anchor.y, z: point.z - anchor.z }) });
        canvasManager.draw();
      }
      return true;
    }
    if (state.editor3Phase === "ready") {
      const overDraggable = (state.objectiveVector3 && !state.objectiveHidden && isObjective3TipAtClient(canvasManager, objective3Tip(state), clientX, clientY)) || findVertex3NearClient(canvasManager, state.vertices3, clientX, clientY) >= 0;
      const pick = findFaceAtClient(canvasManager, state, clientX, clientY);
      setCanvasCursor(overDraggable || pick ? "grab" : "");
      const hovered = pick ? pick.planeIndex : null;
      if (state.hoveredFaceIndex !== hovered) {
        setState({ hoveredFaceIndex: hovered });
        canvasManager.draw();
      }
      return true;
    }
    return true;
  };

  const handleDragMove = (clientX: number, clientY: number) => {
    const initialState = getState();
    if (initialState.problemMode === "3d" && handleDragMove3D(initialState, clientX, clientY)) {
      return;
    }
    const initialInteraction = initialState.editorInteraction;
    const phaseSnapshot = computeDrawingPhase(initialState);
    if (initialInteraction.kind === "idle" && phaseSnapshot === "ready_for_solvers") {
      return;
    }

    const logicalCoords = getLogicalFromClient(canvasManager, clientX, clientY);
    if (initialInteraction.kind === "pending-drag" && exceedsDragThreshold(initialState, clientX, clientY)) {
      setState(
        {
          editorInteraction: {
            kind: "dragging",
            target: initialInteraction.target,
          },
        },
        { viewportDirty: {} },
      );
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
      const kind = interaction.target.kind;
      if (kind === "extrude-handle") {
        // A tall-enough release commits the prism and advances to objective
        // selection; a tiny one just resets the preview.
        const height = getState().extrudePreviewHeight ?? 0;
        if (height >= MIN_EXTRUDE_HEIGHT) {
          commitExtrusion(height);
          fitSolidInView();
        } else setState({ extrudePreviewHeight: null });
        canvasManager.draw();
      }
      setState(
        {
          editorInteraction: { kind: "idle" },
          lastCompletedInteraction:
            kind === "point" || kind === "vertex3"
              ? "dragged-point"
              : kind === "objective" || kind === "objective3"
                ? "dragged-objective"
                : kind === "solver-start"
                  ? "dragged-start"
                  : "dragged-constraint",
        },
        { viewportDirty: {} },
      );
      // a moved start marker changes no geometry, and re-sending the polytope
      // would reset any accumulated trace (comparing paths from different
      // starts is the point of dragging it); 3D targets already committed
      // their edits live through editor3
      if (kind === "point" || kind === "constraint" || kind === "objective") {
        sendPolytope();
      }
    }

    cleanupDragState();
  };

  const handlePointerRelease = (event: MouseEvent | TouchEvent | PointerEvent) => {
    if (getState().isTransitioning3D) return;

    const interactionBeforeEnd = getState();
    handleDragEnd();
    if (interactionBeforeEnd.editorInteraction.kind !== "idle") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  const stopBlockedPointerEvent = (event: MouseEvent | TouchEvent | PointerEvent) => {
    if (getState().editorInteraction.kind === "idle") return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  let lastPointerDownScreen: { x: number; y: number } | null = null;
  let rightPointerDownScreen: { x: number; y: number } | null = null;

  // Right-click (no travel) deletes a solid vertex; right-DRAG is the orbit
  // gesture, so deletion must wait for mouseup and check pointer travel.
  const handleRightPointerUp = (event: MouseEvent) => {
    const start = rightPointerDownScreen;
    rightPointerDownScreen = null;
    const state = getState();
    if (state.problemMode !== "3d" || (state.editor3Phase !== "ready" && state.editor3Phase !== "objective")) return;
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_MOVE_TOLERANCE_PX) return;
    const vertexIndex = findVertex3NearClient(canvasManager, state.vertices3, event.clientX, event.clientY);
    if (vertexIndex < 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (deleteVertex3(vertexIndex)) {
      saveHistory(state);
      canvasManager.draw();
    }
  };

  const handlePointerStart = (clientX: number, clientY: number, event: MouseEvent | TouchEvent | PointerEvent) => {
    if (getState().isTransitioning3D) return;
    lastPointerDownScreen = { x: clientX, y: clientY };
    const handled = handleDragStart(clientX, clientY);
    if (handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
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

  const shouldIgnoreEditEvent = () => {
    const state = getState();
    return state.isTransitioning3D;
  };

  const finishOpenRegion = () => {
    // open (unbounded) base regions are not supported in 3D problem mode,
    // but Enter still closes the base sketch (2D muscle memory)
    if (getState().problemMode === "3d") {
      const state = getState();
      if (state.editor3Phase === "sketch" && state.completionMode === "draft" && state.vertices.length >= 3) {
        applyEditorTransition(getEditorTransition(state, { kind: "click", point: { ...state.vertices[0]! }, closeThreshold: 1 }));
      }
      return;
    }
    const finishResult = getEditorTransition(getState(), {
      kind: "finish-open",
    });
    if (finishResult.kind === "noop") return;

    if (finishResult.kind === "reject-nonconvex") {
      alert(finishResult.reason);
      return;
    }

    if (finishResult.kind !== "edit") return;

    commitEdit(finishResult.result, {
      saveToHistory: finishResult.saveToHistory,
    });
    setCurrentMouse(null);
    canvasManager.set2DPanEnabled(true);
  };

  const handleWheel = (event: WheelEvent) => {
    // in /3d the z axis is a real coordinate; zScale stays pinned
    if (getState().problemMode === "3d") return;
    const { is3DMode, isTransitioning3D, zScale } = getState();
    const is3D = is3DMode || isTransitioning3D;
    if (!is3D || !event.shiftKey || isTransitioning3D) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const zoomFactor = 1.05;
    const dominantDelta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (dominantDelta === 0) return;

    const effectiveScale = (zScale || DEFAULT_Z_SCALE) * (dominantDelta < 0 ? 1 / zoomFactor : zoomFactor);
    const clampedScale = Math.max(0.01, Math.min(100, effectiveScale));
    setState({ zScale: clampedScale });
    canvasManager.draw();
  };

  const handleContextMenu = (event: MouseEvent) => {
    if (shouldIgnoreEditEvent()) return;

    const state = getState();
    // In 3D solid phases, vertex deletion happens on right mouseUP with a
    // travel guard (see handleRightPointerUp) — contextmenu fires at
    // mouseDOWN on macOS, before an orbit can be told apart from a click,
    // and deleting there nuked vertices the user only meant to orbit past.
    // Here we only suppress the browser menu when a vertex is under the
    // pointer.
    if (state.problemMode === "3d" && state.editor3Phase !== "sketch") {
      if (state.editor3Phase !== "ready" && state.editor3Phase !== "objective") return;
      if (findVertex3NearClient(canvasManager, state.vertices3, event.clientX, event.clientY) < 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const local = getLocalFromClient(
      canvasManager,
      event.clientX,
      event.clientY,
    );

    // right-clicking the start marker resets it to the solver default
    if (
      state.solverStartPoint &&
      solverStartNearLocalPoint(canvasManager, state, local.x, local.y)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
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

    event.preventDefault();
    event.stopImmediatePropagation();

    const deletion = getEditorTransition(state, {
      kind: "delete-vertex",
      deleteIndex,
    });
    applyEditorTransition(deletion);
  };

  const handleDoubleClickAt = (clientX: number, clientY: number) => {
    if (shouldIgnoreEditEvent()) return;

    const state3D = getState();
    if (state3D.problemMode === "3d" && state3D.editor3Phase !== "sketch") {
      // double-click a corner to chamfer it, an edge to bevel it, or a face
      // to insert a draggable vertex on it (pull it out to split the facet)
      if ((state3D.editor3Phase === "ready" || state3D.editor3Phase === "objective") && state3D.polytope3) {
        const vertexIndex = findVertex3NearClient(canvasManager, state3D.vertices3, clientX, clientY);
        if (vertexIndex >= 0) {
          if (applyVertexChamfer(vertexIndex)) {
            saveHistory(state3D);
            canvasManager.draw();
          }
          return;
        }
        const edges = currentEdges3();
        const edgeIndex = findEdge3NearClient(canvasManager, state3D.vertices3, edges, clientX, clientY);
        if (edgeIndex >= 0) {
          if (applyEdgeBevel(edges[edgeIndex]!)) {
            saveHistory(state3D);
            canvasManager.draw();
          }
          return;
        }
        const pick = findFaceAtClient(canvasManager, state3D, clientX, clientY);
        if (pick && insertVertex3(pick.point) !== null) {
          saveHistory(state3D);
          canvasManager.draw();
        }
      }
      return;
    }

    const logicalMouse = getLogicalFromClient(canvasManager, clientX, clientY);
    const state = getState();
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

    const edgeIndex = findEdgeNearPoint(logicalMouse, displayVertices, displayMode);
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

  const handleDoubleClick = (event: MouseEvent) => {
    handleDoubleClickAt(event.clientX, event.clientY);
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

  const handleClick = (event: MouseEvent) => {
    const initialState = getState();
    if (shouldIgnoreEditEvent()) return;
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (initialState.lastCompletedInteraction !== "none") {
      setState({ lastCompletedInteraction: "none" });
      return;
    }

    const state = getState();
    if (state.problemMode === "3d") {
      // ignore the click that ends a camera pan/orbit
      if (lastPointerDownScreen && Math.hypot(event.clientX - lastPointerDownScreen.x, event.clientY - lastPointerDownScreen.y) > CLICK_MOVE_TOLERANCE_PX) {
        return;
      }
      if (state.editor3Phase === "objective") {
        const anchor = objectiveAnchor3();
        const pointerPoint = objectivePointFromPointer(canvasManager, anchor, event.clientX, event.clientY);
        const vector = state.currentObjective3 ?? (pointerPoint ? maybeSnapPoint3({ x: pointerPoint.x - anchor.x, y: pointerPoint.y - anchor.y, z: pointerPoint.z - anchor.z }) : null);
        if (!vector) return;
        saveHistory();
        commitObjective3(vector);
        canvasManager.draw();
        return;
      }
      if (state.editor3Phase !== "sketch") return;
      // sketch phase falls through to the 2D drafting click path below
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
          closeThreshold: worldDistanceForPixels(point, CLOSE_HIT_RADIUS_PX),
        }),
      );
    }
  };

  const isTextEntryTarget = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

  // "+" lengthens the replay, "-" shortens it — the flashed readout names the
  // value so the direction is unambiguous. It shows on every press, including
  // one that hits an end of the range, so the keys never feel dead.
  const adjustReplayDuration = (direction: 1 | -1) => {
    const { solverSettings } = getState();
    const replaySpeed = stepReplayDurationMs(
      solverSettings.replaySpeed,
      direction,
    );
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
    // delete the hovered facet of the 3-variable solid
    if (event.key === "Delete" || event.key === "Backspace" || event.key.toLowerCase() === "x") {
      const s = getState();
      if (s.problemMode === "3d" && s.editor3Phase === "ready" && s.hoveredFaceIndex !== null) {
        event.preventDefault();
        if (applyFaceRemoval(s.hoveredFaceIndex)) {
          saveHistory(s);
          canvasManager.draw();
        }
        return;
      }
    }
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
      if (event.button === 2) {
        rightPointerDownScreen = { x: event.clientX, y: event.clientY };
        return;
      }
      if (event.button !== 0) return;
      handlePointerStart(event.clientX, event.clientY, event);
    },
    { capture: true },
  );
  bindEvent(
    canvas,
    "mouseup",
    (event: MouseEvent) => {
      if (event.button === 2) handleRightPointerUp(event);
    },
    { capture: true },
  );
  bindEvent(canvas, "mouseleave", () => {
    setCanvasCursor("");
    if (getState().hoveredFaceIndex !== null) {
      setState({ hoveredFaceIndex: null });
      canvasManager.draw();
    }
  });
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
      const started = activePenStart;
      const interactionBeforeEnd = getState().editorInteraction;
      handlePointerRelease(event);
      activePenStart = null;
      if (started.moved || interactionBeforeEnd.kind === "dragging") return;
      if (registerTap(event.clientX, event.clientY)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
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
      const touch = event.touches[0];
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
      const touch = event.touches[0];
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
      const touch = event.changedTouches[0];
      const started = activeTouchStart;
      const interactionBeforeEnd = getState().editorInteraction;
      handlePointerRelease(event);
      activeTouchStart = null;
      if (!touch || !started || started.moved) return;
      if (interactionBeforeEnd.kind === "dragging") return;
      if (registerTap(touch.clientX, touch.clientY)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
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
  bindEvent(canvas, "dblclick", handleDoubleClick);
  bindEvent(canvas, "click", handleClick);

  return () => {
    cleanupDragState();
    while (cleanupHandlers.length > 0) cleanupHandlers.pop()?.();
  };
}
