import { createAppActions } from "@/app/appActions";
import type { AppContext } from "@/app/appContext";
import { createLayout, DEFAULT_SIDEBAR_WIDTH } from "@/app/layout";
import { createHistoryService } from "@/features/history/historyService";
import { createPolytopeService } from "@/features/polytope-editor/polytopeService";
import { shareLink } from "@/features/share/shareService";
import { applyUrlParamsOnce } from "@/features/share/urlParamsSync";
import { createSolverActions } from "@/features/solver/solverActions";
import type { ViewportRuntime } from "@/features/viewport/runtime";
import { mountCanvasStage } from "@/ui/canvas/mountCanvasStage";
import { mountSidebar } from "@/ui/sidebar/mountSidebar";

export function boot(root: HTMLElement) {
  root.replaceChildren();

  let viewportApi: ViewportRuntime | null = null;
  let urlApplied = false;

  const solver = createSolverActions();
  const polytope = createPolytopeService(solver.handleProblemChange);
  const history = createHistoryService(polytope.derive);
  const actions = createAppActions({ solver, share: shareLink, history, polytope, getViewportApi: () => viewportApi, initialSidebarWidth: DEFAULT_SIDEBAR_WIDTH });
  const layout = createLayout(root, actions);

  const setViewportApi = (runtime: ViewportRuntime | null) => {
    viewportApi = runtime;
    if (runtime && !urlApplied) {
      urlApplied = true;
      applyUrlParamsOnce({
        viewportApi: runtime,
        updateSolverSetting: solver.updateSolverSetting,
        invalidatePendingSolveResults: solver.invalidatePendingSolveResults,
        setActiveSolverMode: solver.setActiveSolverMode,
        derivePolytope: polytope.derive,
      });
    }
  };

  const ctx: AppContext = { actions, services: { history, polytope }, layout, getViewportApi: () => viewportApi, setViewportApi };

  const sidebar = mountSidebar(root, ctx);
  const stage = mountCanvasStage(root, ctx);
  layout.attach({ sidebar, stage });

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
