import { computeDrawingPhase, getState, resetTraceState, setState, setTraceCapacity, on, type SolverMode, type State } from "@/features/core/store";
import { createSolverControls, type SolverControl, type SolverSettingUpdater } from "@/features/solver/solverControls";
import { createReplayController } from "@/features/solver/replayController";
import { createRotationController, objectiveAngleStep } from "@/features/solver/rotationController";
import { createResultPresenter } from "@/features/solver/resultPresenter";
import { createSolveRunner } from "@/features/solver/solveRunner";
import type { ViewportApi } from "@/features/viewport/runtime";
import { isObjectiveDirectionUnbounded } from "@lpviz/polytope/objectiveDirection";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";

export type SolverActions = {
  updateSolverSetting: SolverSettingUpdater;
  setActiveSolverMode: (mode: SolverMode, solve?: boolean) => void;
  setTraceEnabled: (enabled: boolean) => void;
  startRotation: () => void;
  stopRotation: () => void;
  toggleReplay: () => void;
  recomputeIfModeActive: (mode: SolverMode) => void;
  invalidatePendingSolveResults: () => void;
  handleProblemChange: () => void;
  clearComputedState: () => void;
  setConstraintHighlight: (index: number | null) => void;
  setIterateHighlight: (index: number | null) => void;
  solverControls: SolverControl[];
  destroy: () => void;
};

export function createSolverActions(getCanvasManager: () => ViewportApi | null): SolverActions {
  let iterateHoverActive = false;
  const present = createResultPresenter({ getCanvasManager });

  const updateSolverSetting: SolverSettingUpdater = (key, value) =>
    setState({
      solverSettings: { ...getState().solverSettings, [key]: value },
    });
  const hasUnboundedObjectiveDirection = (state: State) =>
    !!(
      hasPolytopeLines(state.polytope) &&
      state.objectiveVector &&
      state.polytope.kind === "unbounded" &&
      isObjectiveDirectionUnbounded(state.polytope.lines, [state.objectiveVector.x, state.objectiveVector.y])
    );
  const solverControls = createSolverControls({
    updateSolverSetting,
    hasUnboundedObjectiveDirection,
  });
  const getSolverControl = (mode: SolverMode) => solverControls.find((c) => c.mode === mode);

  const syncTraceCapacity = () => setTraceCapacity(Math.max(1, Math.ceil((2 * Math.PI) / objectiveAngleStep(getState().solverSettings))));

  const replay = createReplayController({
    getCanvasManager,
    isIterateHoverActive: () => iterateHoverActive,
  });
  const { computePath, invalidatePending: invalidatePendingSolveResults, clearComputedState } = createSolveRunner({ getCanvasManager, present, replay, getSolverControl });

  const rotation = createRotationController({
    computePath,
    syncTraceCapacity,
    hasCanvas: () => getCanvasManager() !== null,
  });
  const setRotationActive = (active: boolean) => {
    replay.cancel();
    if (!active) rotation.cancel();
    else rotation.resetTiming();
    setState({ rotateObjectiveMode: active, highlightIteratePathIndex: null });
    if (!active) present.restoreFullVirtualResult();
  };
  const stopActiveMotion = () => {
    const s = getState();
    const wasRotating = s.rotateObjectiveMode;
    if (!wasRotating && !s.replayActive) return;
    invalidatePendingSolveResults();
    replay.cancel();
    rotation.cancel();
    setState({
      rotateObjectiveMode: false,
      highlightIteratePathIndex: null,
    });
    if (wasRotating) present.restoreFullVirtualResult();
  };
  const handleProblemChange = () => {
    const s = getState();
    const ready = computeDrawingPhase(s) === "ready_for_solvers" && hasPolytopeLines(s.polytope) && s.objectiveVector !== null;
    if (!ready) {
      invalidatePendingSolveResults();
      stopActiveMotion();
      clearComputedState();
      return;
    }
    if (!s.rotateObjectiveMode) {
      resetTraceState();
      void computePath();
      return;
    }
    void computePath().finally(() => rotation.rearm());
  };
  const setTraceEnabled = (enabled: boolean) => {
    const cm = getCanvasManager();
    setState({ traceEnabled: enabled });
    if (!enabled) {
      resetTraceState();
      cm?.draw();
    } else syncTraceCapacity();
  };
  const startRotation = () => {
    if (!getState().objectiveVector) setState({ objectiveVector: { x: 1, y: 0 } });
    if (getState().traceEnabled) {
      syncTraceCapacity();
      resetTraceState();
    }
    setRotationActive(true);
    rotation.begin();
  };
  const recomputeIfModeActive = (mode: SolverMode) => {
    if (!getState().rotateObjectiveMode && getState().solverMode === mode) void computePath();
  };
  const resetTraceAndRedrawIfNeeded = () => {
    if (getState().traceBuffer.length === 0) return;
    resetTraceState();
    getCanvasManager()?.draw();
  };
  const setActiveSolverMode = (mode: SolverMode, solve = false) => {
    invalidatePendingSolveResults();
    if (getState().solverMode !== mode) resetTraceAndRedrawIfNeeded();
    setState({ solverMode: mode });
    if (solve && !getState().rotateObjectiveMode) void computePath();
  };
  const setConstraintHighlight = (index: number | null) => {
    const cm = getCanvasManager();
    if (!cm || getState().highlightIndex === index) return;
    setState({ highlightIndex: index });
    cm.draw();
  };
  const setIterateHighlight = (index: number | null) => {
    const cm = getCanvasManager();
    if (!cm) return;
    iterateHoverActive = index !== null;
    if (getState().highlightIteratePathIndex === index) return;
    setState({ highlightIteratePathIndex: index });
    cm.draw();
  };
  let wasNavigatingViewport = getState().isNavigatingViewport;
  const controller = new AbortController();
  on(
    ["isNavigatingViewport"],
    ({ isNavigatingViewport }) => {
      if (wasNavigatingViewport && !isNavigatingViewport) present.flushDeferred();
      wasNavigatingViewport = isNavigatingViewport;
    },
    controller.signal,
  );
  return {
    updateSolverSetting,
    setActiveSolverMode,
    setTraceEnabled,
    startRotation,
    stopRotation: stopActiveMotion,
    toggleReplay: replay.toggle,
    recomputeIfModeActive,
    invalidatePendingSolveResults,
    handleProblemChange,
    clearComputedState,
    setConstraintHighlight,
    setIterateHighlight,
    solverControls,
    destroy: () => {
      rotation.cancel();
      // stop any active replay; its RAF loop would otherwise keep mutating
      // the store and drawing on the destroyed viewport runtime
      replay.cancel();
      controller.abort();
    },
  };
}
