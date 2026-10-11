import { createSignal } from "@/features/core/signal";
import { deriveViewport2DState, type Viewport2DContext, type Viewport2DState } from "@lpviz/viewport/projection2d";
import type { ViewportPerspectivePose } from "@lpviz/viewport/snapshot";
import { DEFAULT_VIEWPORT_RENDER_SNAPSHOT, type ViewportRenderSnapshot } from "../types";

// What the viewport runtime publishes, each a signal its reader subscribes to: the render snapshot
// the canvas draws from, and the two controls' configurations.

// Fires on every snapshot update (camera pose included); the render loop is
// demand-driven by the dirty flags, so one listener tier is enough.
export const {
  set: setViewportRenderSnapshot,
  reset: resetViewportRenderSnapshot,
  subscribe: subscribeViewportRenderSnapshot,
  get: getViewportRenderSnapshot,
} = createSignal<ViewportRenderSnapshot>(DEFAULT_VIEWPORT_RENDER_SNAPSHOT);

// What the 2D pan/zoom controls read (see three/controllers/panZoom2D.ts): whether they own the
// view, what the view is built from (the state they move, the sidebar, the snapshot that sizes
// it), and where to report a move.
export type Controls2DConfig = Viewport2DContext & {
  enabled: boolean;
  blocked: boolean;
  onStateChange?: (state: Viewport2DState) => void;
  onNavigationFrame?: () => void;
};

export const {
  set: set2DControlsConfig,
  reset: reset2DControlsConfig,
  get: get2DControlsConfig,
} = createSignal<Controls2DConfig>({
  enabled: false,
  blocked: false,
  sidebarWidth: 0,
  state: deriveViewport2DState(DEFAULT_VIEWPORT_RENDER_SNAPSHOT, 0),
  fallbackSnapshot: DEFAULT_VIEWPORT_RENDER_SNAPSHOT,
});

type Controls3DConfig = {
  enabled: boolean;
  blocked: boolean;
  maxDistance: number;
  syncToken: number;
  snapshot: ViewportRenderSnapshot;
  onStart?: () => void;
  onChange?: (pose: ViewportPerspectivePose) => void;
  onEnd?: () => void;
};

export const {
  set: set3DControlsConfig,
  reset: reset3DControlsConfig,
  subscribe: subscribe3DControlsConfig,
  get: get3DControlsConfig,
} = createSignal<Controls3DConfig>({ enabled: false, blocked: false, maxDistance: 1000, syncToken: 0, snapshot: DEFAULT_VIEWPORT_RENDER_SNAPSHOT });
