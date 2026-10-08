// The render snapshot: everything the canvas needs to pose its cameras, as a plain immutable
// value that the app's controls and transition animator publish and every projection reads.

import type { PointXY, PointXYZ } from "@lpviz/math/types";
import { DEFAULT_GRID_SPACING } from "./defaults";

const PERSPECTIVE_FOV_DEGREES = 45;
const PERSPECTIVE_NEAR = 0.1;
const PERSPECTIVE_FAR = 10000;
// the orthographic camera looks straight down the z axis from here
const ORTHOGRAPHIC_HEIGHT = 10;
const DEFAULT_PERSPECTIVE_HEIGHT = 100;

type ViewportMode = "2d" | "3d";

export type ViewportRenderSnapshot = {
  mode: ViewportMode;
  width: number;
  height: number;
  sidebarWidth: number;
  /** pixels per world unit at scale factor 1 */
  gridSpacing: number;
  /** the zoom, so that unitsPerPixel = 1 / (gridSpacing * scaleFactor) */
  scaleFactor: number;
  unitsPerPixel: number;
  /** how much of their height the world-anchored layers show: 0 flat, 1 full, in between mid-transition */
  transitionZMultiplier: number;
  /** what both cameras look at */
  target: PointXYZ;
  orthographic: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    position: PointXYZ;
  };
  perspective: {
    position: PointXYZ;
    up: PointXYZ;
    fov: number;
    near: number;
    far: number;
    aspect: number;
  };
};

/** Where the perspective camera stands, which way is up, and what it looks at. */
export type ViewportPerspectivePose = {
  position: PointXYZ;
  up: PointXYZ;
  target: PointXYZ;
};

export type ViewportRect = Pick<DOMRect, "width" | "height">;

export type ViewportZBounds = { minZ: number; maxZ: number };

export const getViewportSize = (snapshot: ViewportRenderSnapshot, rect?: ViewportRect) => ({ width: rect?.width || snapshot.width || 1, height: rect?.height || snapshot.height || 1 });

// The viewport, and the part of it left for content once the sidebar, a top
// overlay and the padding on each side are taken off (never under 100px).
export const getAvailableViewportSize = (snapshot: ViewportRenderSnapshot, rect: ViewportRect, sidebarWidth: number, padding: number, topInset: number) => {
  const { width, height } = getViewportSize(snapshot, rect);
  return { width, height, availWidth: Math.max(100, width - sidebarWidth - 2 * padding), availHeight: Math.max(100, height - topInset - 2 * padding) };
};

/** The canvas point at the center of what the sidebar leaves visible. */
export function getViewportVisibleCenterCanvasPoint(rect: ViewportRect, sidebarWidth: number): PointXY {
  return { x: sidebarWidth + ((rect.width || 1) - sidebarWidth) / 2, y: (rect.height || 1) / 2 };
}

export const orthographicFor = (width: number, height: number, unitsPerPixel: number, target: PointXY): ViewportRenderSnapshot["orthographic"] => ({
  left: -(width * unitsPerPixel) / 2,
  right: (width * unitsPerPixel) / 2,
  top: (height * unitsPerPixel) / 2,
  bottom: -(height * unitsPerPixel) / 2,
  position: { x: target.x, y: target.y, z: ORTHOGRAPHIC_HEIGHT },
});

export const snapPoint = (point: PointXY, snapToGrid: boolean): PointXY => (snapToGrid ? { x: Math.round(point.x), y: Math.round(point.y) } : point);

/** The 2D view of the origin at scale factor 1, for a viewport of the given size. */
export function createDefaultViewportRenderSnapshot({ width, height }: ViewportRect): ViewportRenderSnapshot {
  const safeWidth = width || 1;
  const safeHeight = height || 1;
  return {
    mode: "2d",
    width: safeWidth,
    height: safeHeight,
    sidebarWidth: 0,
    gridSpacing: DEFAULT_GRID_SPACING,
    scaleFactor: 1,
    unitsPerPixel: 1 / DEFAULT_GRID_SPACING,
    transitionZMultiplier: 1,
    target: { x: 0, y: 0, z: 0 },
    orthographic: {
      left: -safeWidth / (2 * DEFAULT_GRID_SPACING),
      right: safeWidth / (2 * DEFAULT_GRID_SPACING),
      top: safeHeight / (2 * DEFAULT_GRID_SPACING),
      bottom: -safeHeight / (2 * DEFAULT_GRID_SPACING),
      position: { x: 0, y: 0, z: ORTHOGRAPHIC_HEIGHT },
    },
    perspective: {
      position: { x: 0, y: 0, z: DEFAULT_PERSPECTIVE_HEIGHT },
      up: { x: 0, y: 1, z: 0 },
      fov: PERSPECTIVE_FOV_DEGREES,
      near: PERSPECTIVE_NEAR,
      far: PERSPECTIVE_FAR,
      aspect: safeWidth / Math.max(1, safeHeight),
    },
  };
}

export const DEFAULT_VIEWPORT_RENDER_SNAPSHOT: ViewportRenderSnapshot = createDefaultViewportRenderSnapshot({ width: 1, height: 1 });
