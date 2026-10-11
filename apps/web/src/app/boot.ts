import { createAppActions } from "@/app/appActions";
import type { AppContext } from "@/app/appContext";
import { createLayout } from "@/app/layout";
import { createHistoryService } from "@/features/history/historyService";
import { createPolytopeService } from "@/features/polytope-editor/polytopeService";
import { shareLink } from "@/features/share/shareService";
import { applyUrlParamsOnce } from "@/features/share/urlParamsSync";
import { createSolverActions } from "@/features/solver/solverActions";
import { createCanvasStage } from "@/ui/canvas/canvasStage";
import { mountSidebar } from "@/ui/sidebar/mountSidebar";

export function boot(root: HTMLElement) {
  root.replaceChildren();

  const solver = createSolverActions();
  const polytope = createPolytopeService(solver.handleProblemChange);
  const history = createHistoryService(polytope.derive);
  const stage = createCanvasStage(root);
  const actions = createAppActions({ solver, share: shareLink, history, polytope, viewportApi: stage.viewportApi });
  const layout = createLayout(root, actions);
  const ctx: AppContext = { actions, services: { history, polytope }, layout };

  const sidebar = mountSidebar(root, actions);
  stage.mountChrome(ctx);
  layout.attach();
  applyUrlParamsOnce({ viewportApi: stage.viewportApi, derivePolytope: polytope.derive });

  return {
    destroy: () => {
      layout.destroy();
      stage.destroy();
      sidebar.destroy();
      solver.destroy();
      root.replaceChildren();
    },
  };
}
