export type ViewportBridge = {
  getCanvasElement: () => HTMLCanvasElement;
  getCanvasRect: () => DOMRect;
  invalidate: (options?: { layers?: boolean; viewportDirty?: ViewportDirtyFlags }) => void;
};

export type ViewportDirtyFlags = Partial<{
  grid: boolean;
  polytope: boolean;
  constraints: boolean;
  objective: boolean;
  trace: boolean;
  iterate: boolean;
}>;

export type ViewportRenderSnapshot = {
  mode: "2d" | "3d";
  width: number;
  height: number;
  sidebarWidth: number;
  gridSpacing: number;
  scaleFactor: number;
  unitsPerPixel: number;
  transitionZMultiplier: number;
  target: { x: number; y: number; z: number };
  orthographic: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    position: { x: number; y: number; z: number };
  };
  perspective: {
    position: { x: number; y: number; z: number };
    up: { x: number; y: number; z: number };
    fov: number;
    near: number;
    far: number;
    aspect: number;
  };
};

export type ViewportPerspectivePose = {
  position: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
};

export function createDefaultViewportRenderSnapshot({ width, height }: { width: number; height: number }): ViewportRenderSnapshot {
  const safeWidth = width || 1;
  const safeHeight = height || 1;
  return {
    mode: "2d",
    width: safeWidth,
    height: safeHeight,
    sidebarWidth: 0,
    gridSpacing: 20,
    scaleFactor: 1,
    unitsPerPixel: 1 / 20,
    transitionZMultiplier: 1,
    target: { x: 0, y: 0, z: 0 },
    orthographic: {
      left: -safeWidth / 40,
      right: safeWidth / 40,
      top: safeHeight / 40,
      bottom: -safeHeight / 40,
      position: { x: 0, y: 0, z: 10 },
    },
    perspective: {
      position: { x: 0, y: 0, z: 100 },
      up: { x: 0, y: 1, z: 0 },
      fov: 45,
      near: 0.1,
      far: 10000,
      aspect: safeWidth / Math.max(1, safeHeight),
    },
  };
}

export const DEFAULT_VIEWPORT_RENDER_SNAPSHOT: ViewportRenderSnapshot = createDefaultViewportRenderSnapshot({ width: 1, height: 1 });
