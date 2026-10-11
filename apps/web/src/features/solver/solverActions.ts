import { getState, setState } from "@/features/core/store";
import { onAbort } from "@/features/core/lifetime";
import { isReadyForSolvers } from "@/features/problem/selectors";
import { resetTraceState, setTraceCapacity } from "@/features/solver/iterateStore";
import { createReplayController } from "@/features/solver/replayController";
import { createResultPresenter } from "@/features/solver/resultPresenter";
import { createRotationController, objectiveAngleStep } from "@/features/solver/rotationController";
import { createSolveRunner } from "@/features/solver/solveRunner";
import type { SolverMode, SolverSettingUpdater } from "@/features/solver/solverSettings";

export type SolverActions = {
  updateSolverSetting: SolverSettingUpdater;
  /** switch solvers and solve, unless the objective is rotating (its next step solves) */
  setActiveSolverMode: (mode: SolverMode) => void;
  /** solve again (the start marker moved), unless the objective is rotating */
  solveUnlessRotating: () => void;
  setTraceEnabled: (enabled: boolean) => void;
  startRotation: () => void;
  /** stop the objective rotation and any replay */
  stopMotion: () => void;
  toggleReplay: () => void;
  recomputeIfModeActive: (mode: SolverMode) => void;
  handleProblemChange: () => void;
  /** drop the iterates, the trace and the result, and any solve in flight */
  clearComputedState: () => void;
  setConstraintHighlight: (index: number | null) => void;
  setIterateHighlight: (index: number | null) => void;
};

// The solver's actions: the settings and the mode, the objective rotation and the trace it leaves
// (the trail of earlier paths kept on the canvas; not the engine's NumericTrace), the replay and
// the highlights.
export function createSolverActions(signal: AbortSignal): SolverActions {
  // a replay writes highlightIteratePathIndex too, so the field alone cannot say whether the
  // person is hovering a row; the replay asks before it yields the highlight
  let iterateHoverActive = false;
  const presenter = createResultPresenter(signal);

  const updateSolverSetting: SolverSettingUpdater = (key, value) =>
    setState({
      solverSettings: { ...getState().solverSettings, [key]: value },
    });

  const syncTraceCapacity = () => setTraceCapacity(Math.max(1, Math.ceil((2 * Math.PI) / objectiveAngleStep(getState().solverSettings))));

  const replay = createReplayController({ isIterateHoverActive: () => iterateHoverActive });
  const { solve, clearComputedState } = createSolveRunner({ presenter, replay });
  const rotation = createRotationController({ solve, syncTraceCapacity });
  const stopMotion = () => {
    const state = getState();
    const wasRotating = state.rotateObjectiveMode;
    if (!wasRotating && !state.replayActive) return;
    replay.cancel();
    rotation.cancel();
    setState({
      rotateObjectiveMode: false,
      highlightIteratePathIndex: null,
    });
    if (wasRotating) presenter.restoreFullVirtualResult();
  };
  const handleProblemChange = () => {
    const state = getState();
    if (!isReadyForSolvers(state)) {
      stopMotion();
      clearComputedState();
      return;
    }
    if (!state.rotateObjectiveMode) {
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
  // a rotation's next step solves on its own
  const solveUnlessRotating = () => {
    if (!getState().rotateObjectiveMode) void solve();
  };
  const recomputeIfModeActive = (mode: SolverMode) => {
    if (getState().solverMode === mode) solveUnlessRotating();
  };
  const setActiveSolverMode = (mode: SolverMode) => {
    if (getState().solverMode !== mode) resetTraceState();
    setState({ solverMode: mode });
    solveUnlessRotating();
  };
  const setConstraintHighlight = (index: number | null) => setState({ highlightIndex: index });
  const setIterateHighlight = (index: number | null) => {
    iterateHoverActive = index !== null;
    setState({ highlightIteratePathIndex: index });
  };
  // a rotation or a replay would otherwise keep mutating the store and drawing on the torn-down
  // viewport runtime
  onAbort(signal, () => {
    rotation.cancel();
    replay.cancel();
  });
  return {
    updateSolverSetting,
    setActiveSolverMode,
    solveUnlessRotating,
    setTraceEnabled,
    startRotation,
    stopMotion,
    toggleReplay: replay.toggle,
    recomputeIfModeActive,
    handleProblemChange,
    clearComputedState,
    setConstraintHighlight,
    setIterateHighlight,
  };
}
