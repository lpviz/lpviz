import { createAppActions } from "@/app/appActions";
import { createLayout } from "@/app/layout";
import { getState } from "@/features/core/store";
import { createHistoryService } from "@/features/history/historyService";
import { createPolytopeService } from "@/features/polytope-editor/polytopeService";
import { applyUrlParamsOnce, shareLink } from "@/features/share/shareLink";
import { createSolverActions } from "@/features/solver/solverActions";
import { createCanvasStage } from "@/ui/canvas/canvasStage";
import { mountSidebar } from "@/ui/sidebar/mountSidebar";

export function boot(root: HTMLElement) {
  root.replaceChildren();
  const lifetime = new AbortController();
  const { signal } = lifetime;

  const solver = createSolverActions(signal);
  const polytope = createPolytopeService(solver.handleProblemChange);
  const history = createHistoryService(polytope.derive);
  const stage = createCanvasStage(root, signal);
  const editor = { viewportApi: stage.viewportApi, saveHistory: history.save, derivePolytope: polytope.derive, onSolverStartMoved: () => solver.recomputeIfModeActive(getState().solverMode) };
  const actions = createAppActions({ solver, share: shareLink, history, editor });
  const handle = createLayout(root, actions, signal);

  mountSidebar(root, actions, signal);
  stage.mountChrome({ actions, editor, handle });
  applyUrlParamsOnce({ viewportApi: stage.viewportApi, derivePolytope: polytope.derive });

  return {
    destroy: () => {
      lifetime.abort();
      root.replaceChildren();
    },
  };
}
