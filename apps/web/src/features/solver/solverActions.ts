import { getState, on, setState } from "@/features/core/store";
import { isReadyForSolvers } from "@/features/problem/selectors";
import { resetTraceState, setTraceCapacity } from "@/features/solver/iterateStore";
import { createReplayController } from "@/features/solver/replayController";
import { createResultPresenter } from "@/features/solver/resultPresenter";
import { createRotationController, objectiveAngleStep } from "@/features/solver/rotationController";
import { createSolveRunner } from "@/features/solver/solveRunner";
import type { SolverMode, SolverSettingUpdater } from "@/features/solver/solverState";
import type { ViewportApi } from "@/features/viewport/runtime";

export type SolverActions = {
  updateSolverSetting: SolverSettingUpdater;
  setActiveSolverMode: (mode: SolverMode, solve?: boolean) => void;
  setTraceEnabled: (enabled: boolean) => void;
  startRotation: () => void;
  /** stop the objective rotation and any replay */
  stopMotion: () => void;
  toggleReplay: () => void;
  recomputeIfModeActive: (mode: SolverMode) => void;
  invalidatePendingSolveResults: () => void;
  handleProblemChange: () => void;
  clearComputedState: () => void;
  setConstraintHighlight: (index: number | null) => void;
  setIterateHighlight: (index: number | null) => void;
  destroy: () => void;
};

export function createSolverActions(getViewportApi: () => ViewportApi | null): SolverActions {
  let iterateHoverActive = false;
  const presenter = createResultPresenter({ getViewportApi });

  const updateSolverSetting: SolverSettingUpdater = (key, value) =>
    setState({
      solverSettings: { ...getState().solverSettings, [key]: value },
    });

  const syncTraceCapacity = () => setTraceCapacity(Math.max(1, Math.ceil((2 * Math.PI) / objectiveAngleStep(getState().solverSettings))));

  const replay = createReplayController({
    getViewportApi,
    isIterateHoverActive: () => iterateHoverActive,
  });
  const { solve, invalidatePending: invalidatePendingSolveResults, clearComputedState } = createSolveRunner({ getViewportApi, presenter, replay });

  const rotation = createRotationController({
    solve,
    syncTraceCapacity,
    hasCanvas: () => getViewportApi() !== null,
  });
  const stopMotion = () => {
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
    if (wasRotating) presenter.restoreFullVirtualResult();
  };
  const handleProblemChange = () => {
    const s = getState();
    if (!isReadyForSolvers(s)) {
      invalidatePendingSolveResults();
      stopMotion();
      clearComputedState();
      return;
    }
    if (!s.rotateObjectiveMode) {
      resetTraceState();
      void solve();
      return;
    }
    void solve().finally(() => rotation.rearm());
  };
  const setTraceEnabled = (enabled: boolean) => {
    const viewportApi = getViewportApi();
    setState({ traceEnabled: enabled });
    if (!enabled) {
      resetTraceState();
      viewportApi?.draw();
    } else syncTraceCapacity();
  };
  const startRotation = () => {
    if (!getState().objectiveVector) setState({ objectiveVector: [1, 0] });
    if (getState().traceEnabled) {
      syncTraceCapacity();
      resetTraceState();
    }
    replay.cancel();
    setState({ rotateObjectiveMode: true, highlightIteratePathIndex: null });
    rotation.begin();
  };
  const recomputeIfModeActive = (mode: SolverMode) => {
    if (!getState().rotateObjectiveMode && getState().solverMode === mode) void solve();
  };
  const resetTraceAndRedrawIfNeeded = () => {
    if (getState().traceBuffer.length === 0) return;
    resetTraceState();
    getViewportApi()?.draw();
  };
  const setActiveSolverMode = (mode: SolverMode, solveNow = false) => {
    invalidatePendingSolveResults();
    if (getState().solverMode !== mode) resetTraceAndRedrawIfNeeded();
    setState({ solverMode: mode });
    if (solveNow && !getState().rotateObjectiveMode) void solve();
  };
  const setConstraintHighlight = (index: number | null) => {
    const viewportApi = getViewportApi();
    if (!viewportApi || getState().highlightIndex === index) return;
    setState({ highlightIndex: index });
    viewportApi.draw();
  };
  const setIterateHighlight = (index: number | null) => {
    const viewportApi = getViewportApi();
    if (!viewportApi) return;
    iterateHoverActive = index !== null;
    if (getState().highlightIteratePathIndex === index) return;
    setState({ highlightIteratePathIndex: index });
    viewportApi.draw();
  };
  let wasNavigatingViewport = getState().isNavigatingViewport;
  const controller = new AbortController();
  on(
    ["isNavigatingViewport"],
    ({ isNavigatingViewport }) => {
      if (wasNavigatingViewport && !isNavigatingViewport) presenter.flushDeferred();
      wasNavigatingViewport = isNavigatingViewport;
    },
    controller.signal,
  );
  return {
    updateSolverSetting,
    setActiveSolverMode,
    setTraceEnabled,
    startRotation,
    stopMotion,
    toggleReplay: replay.toggle,
    recomputeIfModeActive,
    invalidatePendingSolveResults,
    handleProblemChange,
    clearComputedState,
    setConstraintHighlight,
    setIterateHighlight,
    destroy: () => {
      rotation.cancel();
      // stop any active replay; its RAF loop would otherwise keep mutating
      // the store and drawing on the destroyed viewport runtime
      replay.cancel();
      controller.abort();
    },
  };
}
