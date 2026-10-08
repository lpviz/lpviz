import { createAppActions } from "@/app/appActions";
import type { AppContext } from "@/app/appContext";
import { createLayout, DEFAULT_SIDEBAR_WIDTH } from "@/app/layout";
import { createHistoryService } from "@/features/history/historyService";
import { createPolytopeService } from "@/features/polytope-editor/polytopeService";
import { createShareService } from "@/features/share/shareService";
import { applyUrlParamsOnce } from "@/features/share/urlParamsSync";
import { createSolverActions } from "@/features/solver/solverActions";
import type { ViewportRuntime } from "@/features/viewport/runtime";
import { createViewportActions } from "@/features/viewport/viewportActions";
import { mountCanvasStage } from "@/ui/canvas/mountCanvasStage";
import { mountSidebar } from "@/ui/sidebar/mountSidebar";

export function boot(root: HTMLElement) {
  root.replaceChildren();

  let viewportApi: ViewportRuntime | null = null;
  let urlApplied = false;

  const history = createHistoryService(() => {
    viewportApi?.draw();
    polytope.send();
  });

  const solver = createSolverActions(() => viewportApi);
  const polytope = createPolytopeService(solver.handleProblemChange);
  const viewport = createViewportActions(() => viewportApi, DEFAULT_SIDEBAR_WIDTH);
  const share = createShareService();
  const layout = createLayout(root, viewport);

  const setViewportApi = (runtime: ViewportRuntime | null) => {
    viewportApi = runtime;
    if (runtime && !urlApplied) {
      urlApplied = true;
      applyUrlParamsOnce({
        viewportApi: runtime,
        updateSolverSetting: solver.updateSolverSetting,
        invalidatePendingSolveResults: solver.invalidatePendingSolveResults,
        setActiveSolverMode: solver.setActiveSolverMode,
        sendPolytope: polytope.send,
      });
    }
  };

  const ctx: AppContext = {
    actions: createAppActions({ solver, viewport, share, history, polytope, getViewportApi: () => viewportApi }),
    services: { history, polytope, viewport },

    getViewportApi: () => viewportApi,
    setViewportApi,

    getSidebarWidth: layout.getSidebarWidth,
    getViewportSidebarWidth: layout.getViewportSidebarWidth,
    isMobileLayout: layout.isMobileLayout,
  };

  const sidebar = mountSidebar(root, ctx);
  const stage = mountCanvasStage(root, ctx, layout.onResizeStart);
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
