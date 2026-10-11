import { createSignal } from "@/features/core/signal";
import { deriveViewport2DState, type Viewport2DContext, type Viewport2DState } from "@lpviz/viewport/projection2d";
import { DEFAULT_VIEWPORT_RENDER_SNAPSHOT } from "../types";

// What the 2D pan/zoom controls read (see three/controllers/panZoom2D.ts): whether they own the
// view, what the view is built from (the state they move, the sidebar, the snapshot that sizes
// it), and where to report a move.
export type Controls2DConfig = Viewport2DContext & {
  enabled: boolean;
  blocked: boolean;
  panEnabled: boolean;
  onStateChange?: (state: Viewport2DState) => void;
  onNavigationFrame?: () => void;
};

export const {
  set: set2DControlsConfig,
  reset: reset2DControlsConfig,
  subscribe: subscribe2DControlsConfig,
  get: get2DControlsConfig,
} = createSignal<Controls2DConfig>({
  enabled: false,
  blocked: false,
  panEnabled: true,
  sidebarWidth: 0,
  state: deriveViewport2DState(DEFAULT_VIEWPORT_RENDER_SNAPSHOT, 0),
  fallbackSnapshot: DEFAULT_VIEWPORT_RENDER_SNAPSHOT,
});
