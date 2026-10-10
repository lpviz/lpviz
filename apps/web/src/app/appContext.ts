import type { AppActions } from "@/app/appActions";
import type { Layout } from "@/app/layout";
import type { HistoryService } from "@/features/history/historyService";
import type { PolytopeService } from "@/features/polytope-editor/polytopeService";

export type AppContext = {
  actions: AppActions;
  services: {
    history: HistoryService;
    polytope: PolytopeService;
  };
  layout: Pick<Layout, "getSidebarWidth" | "getViewportSidebarWidth" | "isMobileLayout" | "onResizeStart">;
};
