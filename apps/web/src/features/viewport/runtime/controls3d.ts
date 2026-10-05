import type { ViewportPerspectivePose } from "@lpviz/viewport/types";
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

const DEFAULT_VIEWPORT_3D_CONTROLS_CONFIG: Viewport3DControlsConfig = {
  enabled: false,
  blocked: false,
  maxDistance: 1000,
  syncToken: 0,
  snapshot: DEFAULT_VIEWPORT_RENDER_SNAPSHOT,
};

let config = DEFAULT_VIEWPORT_3D_CONTROLS_CONFIG;
const listeners = new Set<() => void>();

const emit = () => {
  listeners.forEach((listener) => listener());
};

export function setViewport3DControlsConfig(nextConfig: Viewport3DControlsConfig) {
  config = nextConfig;
  emit();
}

export function resetViewport3DControlsConfig() {
  config = DEFAULT_VIEWPORT_3D_CONTROLS_CONFIG;
  emit();
}

export function subscribeViewport3DControlsConfig(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getViewport3DControlsConfig() {
  return config;
}
