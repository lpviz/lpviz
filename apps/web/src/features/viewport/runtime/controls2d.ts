import { getState } from "@/features/core/store";
import type { PointXY } from "@lpviz/math/types";
import { buildViewport2DSnapshot, buildViewport2DStateFromTarget, deriveViewport2DState, type Viewport2DState, zoomViewport2DStateAtCanvasPoint } from "@lpviz/viewport/projection2d";
import type { ViewportRect } from "@lpviz/viewport/types";
import { DEFAULT_VIEWPORT_RENDER_SNAPSHOT, type ViewportRenderSnapshot } from "../types";

type ActivePanState = {
  startClientX: number;
  startClientY: number;
  targetX: number;
  targetY: number;
  scaleFactor: number;
  gridSpacing: number;
};

type Viewport2DControlsConfig = {
  enabled: boolean;
  blocked: boolean;
  panEnabled: boolean;
  sidebarWidth: number;
  state: Viewport2DState;
  fallbackSnapshot: ViewportRenderSnapshot;
  onStateChange?: (state: Viewport2DState) => void;
  onNavigationFrame?: () => void;
};

const DEFAULT_VIEWPORT_2D_CONTROLS_CONFIG: Viewport2DControlsConfig = {
  enabled: false,
  blocked: false,
  panEnabled: true,
  sidebarWidth: 0,
  state: deriveViewport2DState(DEFAULT_VIEWPORT_RENDER_SNAPSHOT, 0),
  fallbackSnapshot: DEFAULT_VIEWPORT_RENDER_SNAPSHOT,
};

let config = DEFAULT_VIEWPORT_2D_CONTROLS_CONFIG;
let activePanState: ActivePanState | null = null;

const applyConfig = (nextConfig: Viewport2DControlsConfig) => {
  config = nextConfig;
  if (!config.enabled || config.blocked || !config.panEnabled) {
    activePanState = null;
  }
};

const canZoomViewport2D = () => config.enabled && !config.blocked;

const canPanViewport2D = () => canZoomViewport2D() && config.panEnabled && getState().editorInteraction.kind === "idle";

export function setViewport2DControlsConfig(nextConfig: Partial<Viewport2DControlsConfig>) {
  applyConfig({
    ...config,
    ...nextConfig,
  });
}

export function resetViewport2DControlsConfig() {
  activePanState = null;
  config = DEFAULT_VIEWPORT_2D_CONTROLS_CONFIG;
}

export function getViewport2DControlsConfig() {
  return config;
}

export function getViewport2DControlsSnapshot(rect: ViewportRect) {
  return buildViewport2DSnapshot(config.state, config.sidebarWidth, rect, config.fallbackSnapshot);
}

export function setViewport2DControlsState(state: Viewport2DState, options: { notify?: boolean } = {}) {
  const nextConfig = {
    ...config,
    state,
  };
  const onStateChange = nextConfig.onStateChange;
  applyConfig(nextConfig);
  if (options.notify !== false) {
    onStateChange?.(state);
  }
}

export function syncViewport2DControlsStateFromSnapshot(snapshot: ViewportRenderSnapshot, sidebarWidth: number) {
  applyConfig({
    ...config,
    sidebarWidth,
    fallbackSnapshot: snapshot,
    state: deriveViewport2DState(snapshot, sidebarWidth),
  });
}

export function startViewport2DPan(clientX: number, clientY: number, rect: ViewportRect) {
  if (!canPanViewport2D()) {
    return false;
  }

  const snapshot = getViewport2DControlsSnapshot(rect);
  activePanState = {
    startClientX: clientX,
    startClientY: clientY,
    targetX: snapshot.target.x,
    targetY: snapshot.target.y,
    scaleFactor: config.state.scaleFactor,
    gridSpacing: config.state.gridSpacing,
  };
  return true;
}

export function updateViewport2DPan(clientX: number, clientY: number) {
  if (!activePanState || !config.enabled) {
    return false;
  }

  const unitsPerPixel = 1 / (activePanState.gridSpacing * activePanState.scaleFactor);
  setViewport2DControlsState(
    buildViewport2DStateFromTarget(
      {
        x: activePanState.targetX - (clientX - activePanState.startClientX) * unitsPerPixel,
        y: activePanState.targetY + (clientY - activePanState.startClientY) * unitsPerPixel,
      },
      activePanState.scaleFactor,
      activePanState.gridSpacing,
      config.sidebarWidth,
    ),
  );
  config.onNavigationFrame?.();
  return true;
}

export function isViewport2DPanActive() {
  return activePanState !== null && config.enabled;
}

export function stopViewport2DPan() {
  if (!activePanState) {
    return false;
  }
  activePanState = null;
  return true;
}

export function zoomViewport2DAtCanvasPoint(point: PointXY, rect: ViewportRect, scaleFactor: number) {
  if (!canZoomViewport2D()) {
    return false;
  }

  setViewport2DControlsState(zoomViewport2DStateAtCanvasPoint(config.state, config.sidebarWidth, rect, config.fallbackSnapshot, point, scaleFactor));
  config.onNavigationFrame?.();
  return true;
}
