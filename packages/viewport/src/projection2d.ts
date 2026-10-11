// The 2D view: an orthographic camera over the plane, described by its target and zoom.

import { type BoundingBox, expandDegenerateBounds } from "@lpviz/math/bounds";
import type { PointXY } from "@lpviz/math/types";
import { DEFAULT_GRID_SPACING, MAX_SCALE_FACTOR, MIN_SCALE_FACTOR } from "./defaults";
import { type FitInsets, getAvailableViewportSize, getViewportSize, orthographicFor, resolveFitInsets, snapPoint, type ViewportRect, type ViewportRenderSnapshot } from "./snapshot";

/** The 2D controls' state: the zoom and the offset of the view from the origin. */
export type Viewport2DState = { gridSpacing: number; scaleFactor: number; offsetX: number; offsetY: number };

/** What the 2D view is built from: the state, the sidebar's width, and the snapshot that sizes it when the rect has no size (and supplies the perspective fields). */
export type Viewport2DContext = { state: Viewport2DState; sidebarWidth: number; fallbackSnapshot: ViewportRenderSnapshot };

export function clampScaleFactor2D(value: number) {
  return Math.max(MIN_SCALE_FACTOR, Math.min(MAX_SCALE_FACTOR, value));
}

// Every snapshot builder keeps unitsPerPixel = 1 / (gridSpacing * clamped
// scaleFactor) (pinned in test/pin.test.ts), so the state follows from the
// target and scale alone.
export function deriveViewport2DState(snapshot: ViewportRenderSnapshot, sidebarWidth: number): Viewport2DState {
  return buildViewport2DStateFromTarget(snapshot.target, snapshot.scaleFactor || 1, snapshot.gridSpacing || DEFAULT_GRID_SPACING, sidebarWidth);
}

export function buildViewport2DStateFromTarget(target: PointXY, scaleFactor: number, gridSpacing: number, sidebarWidth: number): Viewport2DState {
  const clampedScaleFactor = clampScaleFactor2D(scaleFactor);
  const unitsPerPixel = 1 / (gridSpacing * clampedScaleFactor);
  return { gridSpacing, scaleFactor: clampedScaleFactor, offsetX: -target.x - (sidebarWidth / 2) * unitsPerPixel, offsetY: -target.y };
}

export function buildViewport2DSnapshot({ state, sidebarWidth, fallbackSnapshot }: Viewport2DContext, rect: ViewportRect): ViewportRenderSnapshot {
  const scaleFactor = clampScaleFactor2D(state.scaleFactor);
  const unitsPerPixel = 1 / (state.gridSpacing * scaleFactor);
  const { width, height } = getViewportSize(fallbackSnapshot, rect);
  const target = { x: -state.offsetX - (sidebarWidth / 2) * unitsPerPixel, y: -state.offsetY, z: 0 };
  return {
    ...fallbackSnapshot,
    mode: "2d",
    width,
    height,
    sidebarWidth,
    gridSpacing: state.gridSpacing,
    scaleFactor,
    unitsPerPixel,
    transitionZMultiplier: 1,
    target,
    orthographic: orthographicFor(width, height, unitsPerPixel, target),
  };
}

export function toLogicalCoords2D(snapshot: ViewportRenderSnapshot, rect: ViewportRect, point: PointXY, options: { snapToGrid?: boolean } = {}): PointXY {
  const { width, height } = getViewportSize(snapshot, rect);
  return snapPoint({ x: snapshot.target.x + (point.x - width / 2) * snapshot.unitsPerPixel, y: snapshot.target.y + (height / 2 - point.y) * snapshot.unitsPerPixel }, options.snapToGrid ?? false);
}

export function toCanvasCoords2D(snapshot: ViewportRenderSnapshot, rect: ViewportRect, point: PointXY): PointXY {
  const { width, height } = getViewportSize(snapshot, rect);
  return { x: width / 2 + (point.x - snapshot.target.x) / snapshot.unitsPerPixel, y: height / 2 - (point.y - snapshot.target.y) / snapshot.unitsPerPixel };
}

/** The state zoomed to `scaleFactor` with the world point under the canvas `point` held still. */
export function zoomViewport2DStateAtCanvasPoint(context: Viewport2DContext, rect: ViewportRect, point: PointXY, scaleFactor: number): Viewport2DState {
  const { state, sidebarWidth } = context;
  const snapshot = buildViewport2DSnapshot(context, rect);
  const logicalPoint = toLogicalCoords2D(snapshot, rect, point);
  const { width, height } = getViewportSize(snapshot, rect);
  const nextScaleFactor = clampScaleFactor2D(scaleFactor);
  const nextUnitsPerPixel = 1 / (state.gridSpacing * nextScaleFactor);
  const target = { x: logicalPoint.x - (point.x - width / 2) * nextUnitsPerPixel, y: logicalPoint.y - (height / 2 - point.y) * nextUnitsPerPixel };
  return buildViewport2DStateFromTarget(target, nextScaleFactor, state.gridSpacing, sidebarWidth);
}

/**
 * `topInset` is a strip of pixels along the top edge that overlays cover (the
 * problem gallery when it is open); the content is fitted below it, so the
 * available height shrinks by the inset and the content's center sits half
 * an inset below the viewport's.
 */
export function fitViewport2DToBounds(
  { state, sidebarWidth, fallbackSnapshot }: Viewport2DContext,
  rect: ViewportRect,
  rawBounds: BoundingBox,
  fit: Omit<FitInsets, "sidebarWidth"> = {},
): Viewport2DState {
  // Point or axis-aligned content still deserves a recenter and zoom
  const bounds = expandDegenerateBounds(rawBounds);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;

  const insets = resolveFitInsets({ sidebarWidth, ...fit });
  const { availWidth, availHeight } = getAvailableViewportSize(fallbackSnapshot, rect, insets);
  const scaleX = availWidth / (width * state.gridSpacing);
  const scaleY = availHeight / (height * state.gridSpacing);
  const scaleFactor = clampScaleFactor2D(Math.min(scaleX, scaleY));
  // the view center sits half an inset above the content center (world y is
  // up), which puts the content half an inset lower on screen
  const unitsPerPixel = 1 / (state.gridSpacing * scaleFactor);
  return { gridSpacing: state.gridSpacing, scaleFactor, offsetX: -(bounds.minX + bounds.maxX) / 2, offsetY: -((bounds.minY + bounds.maxY) / 2 + (insets.topInset / 2) * unitsPerPixel) };
}
