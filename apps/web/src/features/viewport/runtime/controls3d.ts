import { createSignal } from "@/features/core/signal";
import type { ViewportPerspectivePose } from "@lpviz/viewport/snapshot";
import { DEFAULT_VIEWPORT_RENDER_SNAPSHOT, type ViewportRenderSnapshot } from "../types";

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
