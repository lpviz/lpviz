import { clearIterateState, getState, resetTraceState, type SolverMode } from "@/features/core/store";
import { isReadyForSolvers } from "@/features/problem/selectors";
import type { ReplayController } from "@/features/solver/replayController";
import type { ResultPresenter } from "@/features/solver/resultPresenter";
import type { SolverControl } from "@/features/solver/solverControls";
import { applySolverResult } from "@/features/solver/solverService";
import { runSolverWorker } from "@/features/solver/workerClient";
import type { ViewportApi } from "@/features/viewport/runtime";

// One solve at a time reaches the store: every request carries a generation
// and a reply from an invalidated generation is dropped.
export function createSolveRunner({
  getCanvasManager,
  present,
  replay,
  getSolverControl,
}: {
  getCanvasManager: () => ViewportApi | null;
  present: ResultPresenter;
  replay: ReplayController;
  getSolverControl: (mode: SolverMode) => SolverControl | undefined;
}) {
  let requestGeneration = 0;

  const clearComputedState = () => {
    clearIterateState();
    resetTraceState();
    present.clearResult();
  };
  const invalidatePending = () => {
    requestGeneration++;
  };

  const computePath = async () => {
    const cm = getCanvasManager();
    if (!cm) return;
    // Before anything reads or clears the iterate state: a replay running over
    // a path this call is about to replace (or clear, on the not-ready paths
    // below) would keep drawing its scratch copy of the old one.
    replay.cancel();
    const state = getState();
    const solverDefinition = getSolverControl(state.solverMode);
    if (!solverDefinition || !isReadyForSolvers(state)) {
      invalidatePending();
      clearComputedState();
      return;
    }
    const runBlock = solverDefinition.getRunBlock(state);
    if (runBlock) {
      invalidatePending();
      present.render(runBlock);
      return;
    }
    const request = solverDefinition.buildRequest(state);
    if (!request) {
      invalidatePending();
      clearComputedState();
      return;
    }
    const gen = ++requestGeneration;
    replay.cancel();
    try {
      const response = await runSolverWorker(request);
      if (gen !== requestGeneration) return;
      applySolverResult(response, (payload) => present.render(payload));
      cm.draw();
    } catch (error) {
      if (gen !== requestGeneration) return;
      present.renderError(error instanceof Error ? error.message : String(error));
    }
  };

  return { computePath, invalidatePending, clearComputedState };
}
