import { getState, on, setState } from "@/features/core/store";
import { isReadyForSolvers } from "@/features/problem/selectors";
import { resetTraceState, setTraceCapacity } from "@/features/solver/iterateStore";
import { createReplayController } from "@/features/solver/replayController";
import { createResultPresenter } from "@/features/solver/resultPresenter";
import { createRotationController, objectiveAngleStep } from "@/features/solver/rotationController";
import { createSolveRunner } from "@/features/solver/solveRunner";
import type { SolverMode, SolverSettingUpdater } from "@/features/solver/solverState";

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

export function createSolverActions(): SolverActions {
  let iterateHoverActive = false;
  const presenter = createResultPresenter();

  const updateSolverSetting: SolverSettingUpdater = (key, value) =>
    setState({
      solverSettings: { ...getState().solverSettings, [key]: value },
    });

  const syncTraceCapacity = () => setTraceCapacity(Math.max(1, Math.ceil((2 * Math.PI) / objectiveAngleStep(getState().solverSettings))));

  const replay = createReplayController({ isIterateHoverActive: () => iterateHoverActive });
  const { solve, invalidatePending: invalidatePendingSolveResults, clearComputedState } = createSolveRunner({ presenter, replay });
  const rotation = createRotationController({ solve, syncTraceCapacity });
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
    setState({ traceEnabled: enabled });
    if (enabled) syncTraceCapacity();
    else resetTraceState();
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
  const setActiveSolverMode = (mode: SolverMode, solveNow = false) => {
    invalidatePendingSolveResults();
    if (getState().solverMode !== mode) resetTraceState();
    setState({ solverMode: mode });
    if (solveNow && !getState().rotateObjectiveMode) void solve();
  };
  const setConstraintHighlight = (index: number | null) => setState({ highlightIndex: index });
  const setIterateHighlight = (index: number | null) => {
    iterateHoverActive = index !== null;
    setState({ highlightIteratePathIndex: index });
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
