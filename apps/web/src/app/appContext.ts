import type { AppActions } from "@/app/appActions";
import type { Layout } from "@/app/layout";
import type { EditorDeps } from "@/features/polytope-editor/editorActions";

export type AppContext = {
  actions: AppActions;
  editor: EditorDeps;
  layout: Pick<Layout, "getViewportSidebarWidth" | "onResizeStart">;
};
