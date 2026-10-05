import type { PointXY } from "@lpviz/math/types";

export type ViewportBridge = {
  getCanvasElement: () => HTMLCanvasElement;
  getCanvasRect: () => DOMRect;
  invalidate: (options?: { layers?: boolean; viewportDirty?: ViewportDirtyFlags | undefined }) => void;
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

export type ViewportRect = Pick<DOMRect, "width" | "height">;

export const getViewportSize = (snapshot: ViewportRenderSnapshot, rect?: ViewportRect) => ({ width: rect?.width || snapshot.width || 1, height: rect?.height || snapshot.height || 1 });

// The viewport, and the part of it left for content once the sidebar, a top
// overlay and the padding on each side are taken off (never under 100px).
export const getAvailableViewportSize = (snapshot: ViewportRenderSnapshot, rect: ViewportRect, sidebarWidth: number, padding: number, topInset: number) => {
  const { width, height } = getViewportSize(snapshot, rect);
  return { width, height, availWidth: Math.max(100, width - sidebarWidth - 2 * padding), availHeight: Math.max(100, height - topInset - 2 * padding) };
};

export const orthographicFor = (width: number, height: number, unitsPerPixel: number, target: PointXY): ViewportRenderSnapshot["orthographic"] => ({
  left: -(width * unitsPerPixel) / 2,
  right: (width * unitsPerPixel) / 2,
  top: (height * unitsPerPixel) / 2,
  bottom: -(height * unitsPerPixel) / 2,
  position: { x: target.x, y: target.y, z: 10 },
});

export const snapPoint = (point: PointXY, snapToGrid: boolean): PointXY => (snapToGrid ? { x: Math.round(point.x), y: Math.round(point.y) } : point);

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
