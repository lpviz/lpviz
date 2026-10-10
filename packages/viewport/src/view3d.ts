// The 3D view as a whole: the snapshot of a camera pose, and the poses that reset the view or fit
// the drawn content into what the sidebar and overlays leave visible.

import { Vector3 } from "three";

import { type BoundingBox, expandDegenerateBounds } from "@lpviz/math/bounds";
import type { PointXYZ } from "@lpviz/math/types";
import { DEFAULT_FIT_PADDING, DEFAULT_VIEW_ANGLE, MIN_PERSPECTIVE_DISTANCE, MIN_SCALE_FACTOR } from "./defaults";
import {
  buildPerspectivePoseFromViewAngle,
  getPerspectiveDistanceForUnitsPerPixel,
  getPerspectiveDistanceFromSnapshot3D,
  getScaleFactorFromPerspectiveDistance,
  tanHalfVerticalFov,
  unitsPerPixelAtDistance,
  viewAngleBasis,
} from "./perspective";
import { configurePerspectiveCameraFromSnapshot, projectCanvasPointToWorldPlane } from "./projection3d";
import {
  getAvailableViewportSize,
  getViewportSize,
  getViewportVisibleCenterCanvasPoint,
  perspectiveSnapshot,
  type ViewportPerspectivePose,
  type ViewportRect,
  type ViewportRenderSnapshot,
  type ViewportZBounds,
} from "./snapshot";

type Viewport3DViewState = { viewAngle: PointXYZ; target: PointXYZ; distance: number; pose: ViewportPerspectivePose };

const DEFAULT_TARGET: PointXYZ = { x: 0, y: 0, z: 0 };
const EPS = 1e-6;

const fitRelative = new Vector3();

const clampPerspectiveDistance3D = (snapshot: ViewportRenderSnapshot, distance: number, rect?: ViewportRect) =>
  Math.min(getMaxPerspectiveDistance3D(snapshot, rect), Math.max(MIN_PERSPECTIVE_DISTANCE, distance));

function getPerspectiveDistanceToFitBounds3D(snapshot: ViewportRenderSnapshot, rect: ViewportRect, sidebarWidth: number, bounds: BoundingBox, padding: number, topInset: number) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (width <= 0 || height <= 0) return getDefaultPerspectiveDistance3D(snapshot, rect);

  // The camera renders into the full viewport, so convert "fit the bounds
  // inside the available sub-rectangle" into a required units-per-pixel at
  // the target plane and derive the distance from the full-viewport FOV.
  const viewport = getAvailableViewportSize(snapshot, rect, sidebarWidth, padding, topInset);
  const unitsPerPixel = Math.max(width / viewport.availWidth, height / viewport.availHeight);
  return getPerspectiveDistanceForUnitsPerPixel(snapshot, unitsPerPixel, viewport.height);
}

function getPerspectiveDistanceToFitBox3D(
  snapshot: ViewportRenderSnapshot,
  rect: ViewportRect,
  sidebarWidth: number,
  bounds: BoundingBox & ViewportZBounds,
  target: PointXYZ,
  viewAngle: PointXYZ,
  padding: number,
  topInset: number,
) {
  const viewport = getAvailableViewportSize(snapshot, rect, sidebarWidth, padding, topInset);
  const tanHalfFull = Math.max(EPS, tanHalfVerticalFov(snapshot));
  // Pixels per unit of (offset / depth): px = offset / depth * K
  const K = viewport.height / 2 / tanHalfFull;

  const basis = viewAngleBasis(viewAngle);

  const corners: Array<{ forward: number; right: number; up: number }> = [];
  for (const x of [bounds.minX, bounds.maxX]) {
    for (const y of [bounds.minY, bounds.maxY]) {
      for (const z of [bounds.minZ, bounds.maxZ]) {
        fitRelative.set(x - target.x, y - target.y, z - target.z);
        corners.push({ forward: fitRelative.dot(basis.forward), right: fitRelative.dot(basis.right), up: Math.abs(fitRelative.dot(basis.up)) });
      }
    }
  }

  // The caller aims the camera axis at a target shifted left so that the fit
  // target lands on the visible center (sidebarWidth/2 pixels right of the
  // canvas center, in pixels at the target depth). Corners closer to the
  // camera therefore drift right by more than sidebarWidth/2 pixels, so the
  // available box is asymmetric about the camera axis and depends on the
  // distance itself. Each corner's projection moves monotonically toward the
  // visible center (which is inside the box) as the distance grows, so
  // feasibility is monotone in the distance and bisection finds the tight fit.
  const rightLimitPx = viewport.availWidth / 2 + sidebarWidth / 2;
  const leftLimitPx = viewport.availWidth / 2 - sidebarWidth / 2;
  const verticalLimitPx = viewport.availHeight / 2;

  const fitsAtDistance = (distance: number) => {
    const axisShift = (sidebarWidth / 2) * (distance / K);
    for (const corner of corners) {
      const depth = distance - corner.forward;
      if (depth <= EPS) return false;
      const horizontalPx = ((corner.right + axisShift) * K) / depth;
      if (horizontalPx > rightLimitPx || horizontalPx < -leftLimitPx) return false;
      if ((corner.up * K) / depth > verticalLimitPx) return false;
    }
    return true;
  };

  if (fitsAtDistance(MIN_PERSPECTIVE_DISTANCE)) {
    return MIN_PERSPECTIVE_DISTANCE;
  }
  let hi = MIN_PERSPECTIVE_DISTANCE;
  for (let i = 0; i < 60 && !fitsAtDistance(hi); i++) {
    hi *= 2;
  }
  let lo = hi / 2;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (fitsAtDistance(mid)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

// The camera fills the whole viewport but the sidebar covers its left edge
// and an open gallery its top edge, so the target — what the camera looks
// straight at — is moved left and up in the target plane by half of each, and
// the fitted content lands centered in the part of the viewport that shows.
function offsetTargetForVisibleViewport3D(
  snapshot: ViewportRenderSnapshot,
  rect: ViewportRect,
  target: PointXYZ,
  viewAngle: PointXYZ,
  distance: number,
  sidebarWidth: number,
  topInset: number,
): PointXYZ {
  if (sidebarWidth <= 0 && topInset <= 0) {
    return target;
  }

  const unitsPerPixelAtTarget = unitsPerPixelAtDistance(snapshot, distance, getViewportSize(snapshot, rect).height);
  const rightOffset = (sidebarWidth / 2) * unitsPerPixelAtTarget;
  const upOffset = (topInset / 2) * unitsPerPixelAtTarget;
  const { right, up } = viewAngleBasis(viewAngle);
  return { x: target.x - right.x * rightOffset + up.x * upOffset, y: target.y - right.y * rightOffset + up.y * upOffset, z: target.z - right.z * rightOffset + up.z * upOffset };
}

export function getViewAngleFromSnapshot3D(snapshot: ViewportRenderSnapshot): PointXYZ {
  const { rotation } = configurePerspectiveCameraFromSnapshot(snapshot);
  return { x: -rotation.x, y: -rotation.y, z: -rotation.z };
}

/** The distance at which the target plane shows the 2D view's zoom at scale factor 1. */
export function getDefaultPerspectiveDistance3D(snapshot: ViewportRenderSnapshot, rect?: ViewportRect) {
  return getPerspectiveDistanceForUnitsPerPixel(snapshot, 1 / Math.max(EPS, snapshot.gridSpacing), getViewportSize(snapshot, rect).height);
}

/** The distance matching the 2D view's furthest zoom. */
export function getMaxPerspectiveDistance3D(snapshot: ViewportRenderSnapshot, rect?: ViewportRect) {
  return getPerspectiveDistanceForUnitsPerPixel(snapshot, 1 / Math.max(EPS, snapshot.gridSpacing * MIN_SCALE_FACTOR), getViewportSize(snapshot, rect).height);
}

export function buildResetViewport3DView(snapshot: ViewportRenderSnapshot, sidebarWidth: number, rect: ViewportRect): Viewport3DViewState {
  const distance = clampPerspectiveDistance3D(snapshot, getDefaultPerspectiveDistance3D(snapshot, rect), rect);
  const viewAngle = { ...DEFAULT_VIEW_ANGLE };
  const defaultSnapshot = buildViewport3DSnapshot(snapshot, buildPerspectivePoseFromViewAngle(viewAngle, distance, DEFAULT_TARGET), rect);
  const visibleCenter = projectCanvasPointToWorldPlane(defaultSnapshot, rect, getViewportVisibleCenterCanvasPoint(rect, sidebarWidth), 0);
  // Match the 2D default view, whose visible center shows the world origin:
  // shift the origin target back by whatever the visible center (which
  // already accounts for the sidebar) projects to.
  const target = visibleCenter ? { x: 0 - visibleCenter.x, y: 0 - visibleCenter.y, z: 0 } : DEFAULT_TARGET;
  return { viewAngle, target, distance, pose: buildPerspectivePoseFromViewAngle(viewAngle, distance, target) };
}

export function fitViewport3DToBounds(
  snapshot: ViewportRenderSnapshot,
  rect: ViewportRect,
  sidebarWidth: number,
  rawBounds: BoundingBox,
  padding = DEFAULT_FIT_PADDING,
  zBounds?: ViewportZBounds,
  topInset = 0,
): Viewport3DViewState {
  // Point or axis-aligned content still deserves a recenter and zoom
  const bounds = expandDegenerateBounds(rawBounds);
  const viewAngle = getViewAngleFromSnapshot3D(snapshot);
  const fitTarget = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, z: 0 };
  const unclampedDistance = zBounds
    ? getPerspectiveDistanceToFitBox3D(snapshot, rect, sidebarWidth, { ...bounds, minZ: zBounds.minZ, maxZ: zBounds.maxZ }, fitTarget, viewAngle, padding, topInset)
    : getPerspectiveDistanceToFitBounds3D(snapshot, rect, sidebarWidth, bounds, padding, topInset);
  const distance = clampPerspectiveDistance3D(snapshot, unclampedDistance, rect);
  const target = offsetTargetForVisibleViewport3D(snapshot, rect, fitTarget, viewAngle, distance, sidebarWidth, topInset);
  return { viewAngle, target, distance, pose: buildPerspectivePoseFromViewAngle(viewAngle, distance, target) };
}

/** The 3D snapshot of a camera pose, keeping the 2D zoom fields in step with the camera's distance. */
export function buildViewport3DSnapshot(snapshot: ViewportRenderSnapshot, pose: ViewportPerspectivePose, rect?: ViewportRect): ViewportRenderSnapshot {
  const { width, height } = getViewportSize(snapshot, rect);
  const distance = Math.hypot(pose.position.x - pose.target.x, pose.position.y - pose.target.y, pose.position.z - pose.target.z);
  const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : getPerspectiveDistanceFromSnapshot3D(snapshot);
  const scaleFactor = getScaleFactorFromPerspectiveDistance(snapshot, safeDistance, height);
  const unitsPerPixel = 1 / Math.max(EPS, snapshot.gridSpacing * scaleFactor);
  return perspectiveSnapshot(snapshot, pose, width, height, scaleFactor, unitsPerPixel, 1);
}
