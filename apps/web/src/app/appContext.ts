import type { AppActions } from "@/app/appActions";
import type { HistoryService } from "@/features/history/historyService";
import type { PolytopeService } from "@/features/polytope-editor/polytopeService";
import type { ViewportRuntime } from "@/features/viewport/runtime";

export type AppContext = {
  actions: AppActions;
  services: {
    history: HistoryService;
    polytope: PolytopeService;
  };
  getViewportApi: () => ViewportRuntime | null;
  setViewportApi: (runtime: ViewportRuntime | null) => void;
  getSidebarWidth: () => number;
  getViewportSidebarWidth: () => number;
  isMobileLayout: () => boolean;
};
