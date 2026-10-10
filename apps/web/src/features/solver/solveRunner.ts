import { getState } from "@/features/core/store";
import { isReadyForSolvers } from "@/features/problem/selectors";
import { clearIterateState, resetTraceState, setIterateResult } from "@/features/solver/iterateStore";
import type { ReplayController } from "@/features/solver/replayController";
import { renderPayload, type ResultPresenter } from "@/features/solver/resultPresenter";
import { activeSolverControl } from "@/features/solver/solverControls";
import { runSolverWorker } from "@/features/solver/workerClient";

// One solve at a time reaches the store: every request carries a generation
// and a reply from an invalidated generation is dropped.
export function createSolveRunner({ presenter, replay }: { presenter: ResultPresenter; replay: ReplayController }) {
  let requestGeneration = 0;

  const clearComputedState = () => {
    clearIterateState();
    resetTraceState();
    presenter.clearResult();
  };
  const invalidatePending = () => {
    requestGeneration++;
  };

  // Solve the current problem with the selected solver, or show why it cannot be solved.
  const solve = async () => {
    // Before anything reads or clears the iterate state: a replay running over
    // a path this call is about to replace (or clear, on the not-ready paths
    // below) would keep drawing its scratch copy of the old one.
    replay.cancel();
    invalidatePending();
    const generation = requestGeneration;
    const state = getState();
    if (!isReadyForSolvers(state)) {
      clearComputedState();
      return;
    }
    const control = activeSolverControl();
    const runBlock = control.getRunBlock(state);
    if (runBlock) {
      presenter.render(runBlock);
      return;
    }
    const request = control.buildRequest(state);
    if (!request) {
      clearComputedState();
      return;
    }
    try {
      const { result } = await runSolverWorker(request);
      if (generation !== requestGeneration) return;
      setIterateResult(result);
      presenter.render(renderPayload(result.log));
    } catch (error) {
      if (generation !== requestGeneration) return;
      presenter.renderError(error instanceof Error ? error.message : String(error));
    }
  };

  return { solve, invalidatePending, clearComputedState };
}
