import { createSignal } from "@/features/core/signal";
import type { ViewportPerspectivePose } from "@lpviz/viewport/snapshot";
import { DEFAULT_VIEWPORT_RENDER_SNAPSHOT, type ViewportRenderSnapshot } from "../types";

export type { ViewportPerspectivePose };

type Viewport3DControlsConfig = {
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
  set: setViewport3DControlsConfig,
  reset: resetViewport3DControlsConfig,
  subscribe: subscribeViewport3DControlsConfig,
  get: getViewport3DControlsConfig,
} = createSignal<Viewport3DControlsConfig>({ enabled: false, blocked: false, maxDistance: 1000, syncToken: 0, snapshot: DEFAULT_VIEWPORT_RENDER_SNAPSHOT });
