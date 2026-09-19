import { Euler, PerspectiveCamera, Vector3 } from "three";

import { type BoundingBox, expandDegenerateBounds } from "@lpviz/math/geometry";
import type { PointXYZ } from "@lpviz/math/types";
import { DEFAULT_VIEW_ANGLE } from "./defaults";
import {
  buildPerspectivePoseFromViewAngle,
  getPerspectiveDistanceForUnitsPerPixel,
  getScaleFactorFromPerspectiveDistance,
  getViewportVisibleCenterCanvasPoint,
  projectCanvasPointToWorldPlane,
} from "./transition";
import type { ViewportPerspectivePose, ViewportRenderSnapshot } from "./types";

type ViewportRect = Pick<DOMRect, "width" | "height">;

type ViewportZBounds = {
  minZ: number;
  maxZ: number;
};

export type Viewport3DViewState = {
  viewAngle: PointXYZ;
  target: PointXYZ;
  distance: number;
  pose: ViewportPerspectivePose;
};

const DEFAULT_TARGET: PointXYZ = { x: 0, y: 0, z: 0 };
const ORTHO_MIN_SCALE_FACTOR = 0.05;
const MIN_PERSPECTIVE_DISTANCE = 10;
const EPS = 1e-6;

const snapshotCamera = new PerspectiveCamera();
const snapshotTarget = new Vector3();
const fitEuler = new Euler();
const fitForward = new Vector3();
const fitUp = new Vector3();
const fitRight = new Vector3();
const fitRelative = new Vector3();

const getViewportSize = (
  snapshot: ViewportRenderSnapshot,
  rect?: ViewportRect,
) => ({
  width: rect?.width || snapshot.width || 1,
  height: rect?.height || snapshot.height || 1,
});

const configurePerspectiveCameraFromSnapshot = (
  snapshot: ViewportRenderSnapshot,
) => {
  snapshotCamera.fov = snapshot.perspective.fov;
  snapshotCamera.aspect = snapshot.perspective.aspect;
  snapshotCamera.near = snapshot.perspective.near;
  snapshotCamera.far = snapshot.perspective.far;
  snapshotCamera.position.set(
    snapshot.perspective.position.x,
    snapshot.perspective.position.y,
    snapshot.perspective.position.z,
  );
  snapshotCamera.up.set(
    snapshot.perspective.up.x,
    snapshot.perspective.up.y,
    snapshot.perspective.up.z,
  );
  snapshotTarget.set(snapshot.target.x, snapshot.target.y, snapshot.target.z);
  snapshotCamera.lookAt(snapshotTarget);
  snapshotCamera.updateProjectionMatrix();
  snapshotCamera.updateMatrixWorld();
};

const configureFitBasisFromViewAngle = (viewAngle: PointXYZ) => {
  fitEuler.set(-viewAngle.x, -viewAngle.y, -viewAngle.z, "XYZ");
  fitForward.set(0, 0, 1).applyEuler(fitEuler).normalize();
  fitUp.set(0, 1, 0).applyEuler(fitEuler).normalize();
  fitRight.crossVectors(fitUp, fitForward).normalize();
};

const approxEqual = (a: number, b: number, tolerance = 1e-3) =>
  Math.abs(a - b) <= tolerance;

const clampPerspectiveDistance3D = (
  snapshot: ViewportRenderSnapshot,
  distance: number,
  rect?: ViewportRect,
) =>
  Math.min(
    getMaxPerspectiveDistance3D(snapshot, rect),
    Math.max(MIN_PERSPECTIVE_DISTANCE, distance),
  );

const getPerspectiveDistanceToFitBounds3D = (
  snapshot: ViewportRenderSnapshot,
  rect: ViewportRect,
  sidebarWidth: number,
  bounds: BoundingBox,
  padding = 50,
  topInset = 0,
) => {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (width <= 0 || height <= 0) {
    return getDefaultPerspectiveDistance3D(snapshot, rect);
  }

  // The camera renders into the full viewport, so convert "fit the bounds
  // inside the available sub-rectangle" into a required units-per-pixel at
  // the target plane and derive the distance from the full-viewport FOV.
  const viewport = getViewportSize(snapshot, rect);
  const availWidth = Math.max(100, viewport.width - sidebarWidth - 2 * padding);
  const availHeight = Math.max(100, viewport.height - topInset - 2 * padding);
  const unitsPerPixel = Math.max(width / availWidth, height / availHeight);

  return Math.max(
    MIN_PERSPECTIVE_DISTANCE,
    getPerspectiveDistanceForUnitsPerPixel(
      snapshot,
      unitsPerPixel,
      viewport.height,
    ),
  );
};

const getPerspectiveDistanceToFitBox3D = (
  snapshot: ViewportRenderSnapshot,
  rect: ViewportRect,
  sidebarWidth: number,
  bounds: BoundingBox & ViewportZBounds,
  target: PointXYZ,
  viewAngle: PointXYZ,
  padding = 50,
  topInset = 0,
) => {
  const viewport = getViewportSize(snapshot, rect);
  const availWidth = Math.max(100, viewport.width - sidebarWidth - 2 * padding);
  const availHeight = Math.max(100, viewport.height - topInset - 2 * padding);
  const verticalFov = snapshot.perspective.fov * (Math.PI / 180);
  const tanHalfFull = Math.max(EPS, Math.tan(verticalFov / 2));
  // Pixels per unit of (offset / depth): px = offset / depth * K
  const K = viewport.height / 2 / tanHalfFull;

  configureFitBasisFromViewAngle(viewAngle);

  const xs = [bounds.minX, bounds.maxX];
  const ys = [bounds.minY, bounds.maxY];
  const zs = [bounds.minZ, bounds.maxZ];
  const corners: Array<{ forward: number; right: number; up: number }> = [];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        fitRelative.set(x - target.x, y - target.y, z - target.z);
        corners.push({
          forward: fitRelative.dot(fitForward),
          right: fitRelative.dot(fitRight),
          up: Math.abs(fitRelative.dot(fitUp)),
        });
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
  const rightLimitPx = availWidth / 2 + sidebarWidth / 2;
  const leftLimitPx = availWidth / 2 - sidebarWidth / 2;
  const verticalLimitPx = availHeight / 2;

  const fitsAtDistance = (distance: number) => {
    const axisShift = (sidebarWidth / 2) * (distance / K);
    for (const corner of corners) {
      const depth = distance - corner.forward;
      if (depth <= EPS) return false;
      const horizontalPx = ((corner.right + axisShift) * K) / depth;
      if (horizontalPx > rightLimitPx || horizontalPx < -leftLimitPx)
        return false;
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
};

// The camera fills the whole viewport but the sidebar covers its left edge
// and an open gallery its top edge, so the target — what the camera looks
// straight at — is moved left and up in the target plane by half of each, and
// the fitted content lands centered in the part of the viewport that shows.
const offsetTargetForVisibleViewport3D = (
  snapshot: ViewportRenderSnapshot,
  rect: ViewportRect,
  target: PointXYZ,
  viewAngle: PointXYZ,
  distance: number,
  sidebarWidth: number,
  topInset = 0,
): PointXYZ => {
  if (sidebarWidth <= 0 && topInset <= 0) {
    return target;
  }

  const viewport = getViewportSize(snapshot, rect);
  const verticalFov = snapshot.perspective.fov * (Math.PI / 180);
  const unitsPerPixelAtTarget =
    (2 *
      Math.tan(verticalFov / 2) *
      Math.max(MIN_PERSPECTIVE_DISTANCE, distance)) /
    Math.max(1, viewport.height);
  const rightOffset = (sidebarWidth / 2) * unitsPerPixelAtTarget;
  const upOffset = (topInset / 2) * unitsPerPixelAtTarget;
  configureFitBasisFromViewAngle(viewAngle);

  return {
    x: target.x - fitRight.x * rightOffset + fitUp.x * upOffset,
    y: target.y - fitRight.y * rightOffset + fitUp.y * upOffset,
    z: target.z - fitRight.z * rightOffset + fitUp.z * upOffset,
  };
};

export function getViewAngleFromSnapshot3D(
  snapshot: ViewportRenderSnapshot,
): PointXYZ {
  configurePerspectiveCameraFromSnapshot(snapshot);
  return {
    x: -snapshotCamera.rotation.x,
    y: -snapshotCamera.rotation.y,
    z: -snapshotCamera.rotation.z,
  };
}

export function getPerspectiveDistanceFromSnapshot3D(
  snapshot: ViewportRenderSnapshot,
) {
  return snapshotCamera.position
    .set(
      snapshot.perspective.position.x,
      snapshot.perspective.position.y,
      snapshot.perspective.position.z,
    )
    .distanceTo(
      snapshotTarget.set(
        snapshot.target.x,
        snapshot.target.y,
        snapshot.target.z,
      ),
    );
}

export function getDefaultPerspectiveDistance3D(
  snapshot: ViewportRenderSnapshot,
  rect?: ViewportRect,
) {
  return getPerspectiveDistanceForUnitsPerPixel(
    snapshot,
    1 / Math.max(EPS, snapshot.gridSpacing),
    getViewportSize(snapshot, rect).height,
  );
}

export function getMaxPerspectiveDistance3D(
  snapshot: ViewportRenderSnapshot,
  rect?: ViewportRect,
) {
  return getPerspectiveDistanceForUnitsPerPixel(
    snapshot,
    1 / Math.max(EPS, snapshot.gridSpacing * ORTHO_MIN_SCALE_FACTOR),
    getViewportSize(snapshot, rect).height,
  );
}

export function buildResetViewport3DView(
  snapshot: ViewportRenderSnapshot,
  sidebarWidth: number,
  rect: ViewportRect,
): Viewport3DViewState {
  const distance = clampPerspectiveDistance3D(
    snapshot,
    getDefaultPerspectiveDistance3D(snapshot, rect),
    rect,
  );
  const viewAngle = { ...DEFAULT_VIEW_ANGLE };
  const defaultPose = buildPerspectivePoseFromViewAngle(
    viewAngle,
    distance,
    DEFAULT_TARGET,
  );
  const defaultSnapshot = buildViewport3DSnapshot(snapshot, defaultPose, rect);
  const visibleCenter = projectCanvasPointToWorldPlane(
    defaultSnapshot,
    rect,
    getViewportVisibleCenterCanvasPoint(rect, sidebarWidth),
    0,
  );
  // Match the 2D default view, whose visible center shows the world origin
  // (the sidebar offset is already accounted for by projecting the visible
  // center below).
  const desiredCenter = { x: 0, y: 0 };
  const target = visibleCenter
    ? {
        x: DEFAULT_TARGET.x + desiredCenter.x - visibleCenter.x,
        y: DEFAULT_TARGET.y + desiredCenter.y - visibleCenter.y,
        z: DEFAULT_TARGET.z,
      }
    : DEFAULT_TARGET;

  return {
    viewAngle,
    target,
    distance,
    pose: buildPerspectivePoseFromViewAngle(viewAngle, distance, target),
  };
}

export function fitViewport3DToBounds(
  snapshot: ViewportRenderSnapshot,
  rect: ViewportRect,
  sidebarWidth: number,
  rawBounds: BoundingBox,
  padding = 50,
  zBounds?: ViewportZBounds,
  topInset = 0,
): Viewport3DViewState | null {
  // Point or axis-aligned content still deserves a recenter and zoom
  const bounds = expandDegenerateBounds(rawBounds);
  const viewAngle = getViewAngleFromSnapshot3D(snapshot);
  const fitTarget = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: 0,
  };
  const unclampedDistance = zBounds
    ? getPerspectiveDistanceToFitBox3D(
        snapshot,
        rect,
        sidebarWidth,
        {
          ...bounds,
          minZ: zBounds.minZ,
          maxZ: zBounds.maxZ,
        },
        fitTarget,
        viewAngle,
        padding,
        topInset,
      )
    : getPerspectiveDistanceToFitBounds3D(
        snapshot,
        rect,
        sidebarWidth,
        bounds,
        padding,
        topInset,
      );
  const distance = clampPerspectiveDistance3D(
    snapshot,
    unclampedDistance,
    rect,
  );
  const target = offsetTargetForVisibleViewport3D(
    snapshot,
    rect,
    fitTarget,
    viewAngle,
    distance,
    sidebarWidth,
    topInset,
  );

  return {
    viewAngle,
    target,
    distance,
    pose: buildPerspectivePoseFromViewAngle(viewAngle, distance, target),
  };
}

export function buildViewport3DSnapshot(
  snapshot: ViewportRenderSnapshot,
  pose: ViewportPerspectivePose,
  rect?: ViewportRect,
): ViewportRenderSnapshot {
  const { width, height } = getViewportSize(snapshot, rect);
  const distance = Math.hypot(
    pose.position.x - pose.target.x,
    pose.position.y - pose.target.y,
    pose.position.z - pose.target.z,
  );
  const safeDistance =
    Number.isFinite(distance) && distance > 0
      ? distance
      : getPerspectiveDistanceFromSnapshot3D(snapshot);
  const scaleFactor = getScaleFactorFromPerspectiveDistance(
    snapshot,
    safeDistance,
    height,
  );
  const unitsPerPixel = 1 / Math.max(EPS, snapshot.gridSpacing * scaleFactor);

  return {
    ...snapshot,
    mode: "3d",
    width,
    height,
    scaleFactor,
    unitsPerPixel,
    transitionZMultiplier: 1,
    target: { ...pose.target },
    orthographic: {
      left: -(width * unitsPerPixel) / 2,
      right: (width * unitsPerPixel) / 2,
      top: (height * unitsPerPixel) / 2,
      bottom: -(height * unitsPerPixel) / 2,
      position: {
        x: pose.target.x,
        y: pose.target.y,
        z: 10,
      },
    },
    perspective: {
      ...snapshot.perspective,
      position: { ...pose.position },
      up: { ...pose.up },
      aspect: width / Math.max(1, height),
    },
  };
}

export function isDefault3DView(
  snapshot: ViewportRenderSnapshot,
  sidebarWidth = 0,
  rect?: ViewportRect,
) {
  if (snapshot.mode !== "3d") {
    return false;
  }

  // Compare against the target a reset would produce: with a sidebar the
  // reset target is offset so the world origin sits at the visible center.
  const resetView = buildResetViewport3DView(
    snapshot,
    sidebarWidth,
    rect ?? getViewportSize(snapshot),
  );
  const viewAngle = getViewAngleFromSnapshot3D(snapshot);
  return (
    approxEqual(snapshot.scaleFactor, 1) &&
    approxEqual(snapshot.target.x, resetView.target.x) &&
    approxEqual(snapshot.target.y, resetView.target.y) &&
    approxEqual(snapshot.target.z, resetView.target.z) &&
    approxEqual(viewAngle.x, DEFAULT_VIEW_ANGLE.x, 1e-2) &&
    approxEqual(viewAngle.y, DEFAULT_VIEW_ANGLE.y, 1e-2) &&
    approxEqual(viewAngle.z, DEFAULT_VIEW_ANGLE.z, 1e-2)
  );
}
