import { Euler, Vector3 } from "three";

import type { PointXY, PointXYZ } from "@lpviz/math/types";
import { DEFAULT_VIEW_ANGLE } from "./defaults";
import { clampScaleFactor2D, type Viewport2DState } from "./projection2d";
import { getPerspectiveDistanceFromSnapshot3D, projectCanvasPointToWorldPlane } from "./projection3d";
import { getViewportSize, orthographicFor, type ViewportDirtyFlags, type ViewportPerspectivePose, type ViewportRect, type ViewportRenderSnapshot } from "./types";

export type ViewportTransitionPlan = {
  baseSnapshot: ViewportRenderSnapshot;
  direction: "to3d" | "to2d";
  duration: number;
  startAngles: PointXYZ;
  endAngles: PointXYZ;
  startTarget: PointXYZ;
  endTarget: PointXYZ;
  perspectiveDistance: number;
};

export type ViewportTransitionFrame = {
  viewAngle: PointXYZ;
  target: PointXYZ;
  pose: ViewportPerspectivePose;
  snapshot: ViewportRenderSnapshot;
};

export type ViewportTransitionStatePatch = {
  isTransitioning3D: boolean;
  transitionStartTime: number;
  transition3DStartAngles: PointXYZ;
  transition3DEndAngles: PointXYZ;
  transitionDirection: "to3d" | "to2d" | null;
  transitionProgress: number;
  is3DMode: boolean;
  viewAngle: PointXYZ;
};

export const TRANSITION_VIEWPORT_DIRTY_FLAGS: ViewportDirtyFlags = {
  polytope: true,
  objective: true,
  trace: true,
  iterate: true,
};

const ZERO_VIEW_ANGLE: PointXYZ = { x: 0, y: 0, z: 0 };
const lerp = (start: number, end: number, t: number) => start + (end - start) * t;
const getUnitsPerPixel = (gridSpacing: number, scaleFactor: number) => 1 / (gridSpacing * clampScaleFactor2D(scaleFactor));

const transitionEuler = new Euler();
const transitionDirection = new Vector3();
const transitionPosition = new Vector3();
const transitionUp = new Vector3();

export { projectCanvasPointToWorldPlane };

export function getPerspectiveDistanceForUnitsPerPixel(snapshot: ViewportRenderSnapshot, unitsPerPixel: number, height = snapshot.height || 1) {
  const fov = snapshot.perspective.fov * (Math.PI / 180);
  return Math.max(10, (height * unitsPerPixel) / (2 * Math.tan(fov / 2)));
}

export function getScaleFactorFromPerspectiveDistance(snapshot: ViewportRenderSnapshot, distance: number, height = snapshot.height || 1) {
  const fov = snapshot.perspective.fov * (Math.PI / 180);
  const safeDistance = Math.max(10, distance);
  const viewportHeight = 2 * Math.tan(fov / 2) * safeDistance;
  const unitsPerPixel = viewportHeight / Math.max(1, height);
  return clampScaleFactor2D(1 / (unitsPerPixel * snapshot.gridSpacing));
}

export function buildViewportTransitionPlan({ snapshot, targetMode, viewAngle }: { snapshot: ViewportRenderSnapshot; targetMode: boolean; viewAngle: PointXYZ }): ViewportTransitionPlan {
  const direction = targetMode ? "to3d" : "to2d";
  const duration = targetMode ? 400 : 500;
  const startTarget = {
    x: snapshot.target.x,
    y: snapshot.target.y,
    z: snapshot.target.z,
  };
  const endTarget = targetMode
    ? { ...startTarget }
    : {
        x: startTarget.x,
        y: startTarget.y,
        z: 0,
      };

  const snapshotDistance = getPerspectiveDistanceFromSnapshot3D(snapshot);
  const perspectiveDistance = targetMode
    ? getPerspectiveDistanceForUnitsPerPixel(snapshot, snapshot.unitsPerPixel, snapshot.height)
    : Number.isFinite(snapshotDistance) && snapshotDistance > 0
      ? Math.max(10, snapshotDistance)
      : getPerspectiveDistanceForUnitsPerPixel(snapshot, snapshot.unitsPerPixel, snapshot.height);

  return {
    baseSnapshot: snapshot,
    direction,
    duration,
    startAngles: targetMode ? { ...ZERO_VIEW_ANGLE } : { ...viewAngle },
    endAngles: targetMode ? { ...DEFAULT_VIEW_ANGLE } : { ...ZERO_VIEW_ANGLE },
    startTarget,
    endTarget,
    perspectiveDistance,
  };
}

function interpolateTransitionViewAngle(plan: ViewportTransitionPlan, progress: number): PointXYZ {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  return {
    x: lerp(plan.startAngles.x, plan.endAngles.x, clampedProgress),
    y: lerp(plan.startAngles.y, plan.endAngles.y, clampedProgress),
    z: lerp(plan.startAngles.z, plan.endAngles.z, clampedProgress),
  };
}

export function buildTransitionStartState(targetMode: boolean, startTime: number, plan: ViewportTransitionPlan): Partial<ViewportTransitionStatePatch> {
  return {
    isTransitioning3D: true,
    transitionStartTime: startTime,
    transition3DStartAngles: { ...plan.startAngles },
    transition3DEndAngles: { ...plan.endAngles },
    transitionDirection: plan.direction,
    transitionProgress: 0,
    is3DMode: targetMode,
    viewAngle: { ...plan.startAngles },
  };
}

export function buildTransitionCompleteState(plan: ViewportTransitionPlan): Pick<ViewportTransitionStatePatch, "isTransitioning3D" | "transitionDirection" | "transitionProgress" | "viewAngle"> {
  return {
    isTransitioning3D: false,
    transitionDirection: null,
    transitionProgress: 0,
    viewAngle: { ...plan.endAngles },
  };
}

export function buildPerspectivePoseFromViewAngle(viewAngle: PointXYZ, distance: number, target: PointXYZ): ViewportPerspectivePose {
  transitionEuler.set(-viewAngle.x, -viewAngle.y, -viewAngle.z, "XYZ");
  transitionDirection.set(0, 0, 1).applyEuler(transitionEuler).normalize();
  transitionPosition.set(target.x, target.y, target.z).add(transitionDirection.multiplyScalar(Math.max(10, distance)));
  transitionUp.set(0, 1, 0).applyEuler(transitionEuler).normalize();

  return {
    position: {
      x: transitionPosition.x,
      y: transitionPosition.y,
      z: transitionPosition.z,
    },
    up: {
      x: transitionUp.x,
      y: transitionUp.y,
      z: transitionUp.z,
    },
    target: {
      x: target.x,
      y: target.y,
      z: target.z,
    },
  };
}

export function buildViewportTransitionFrame(plan: ViewportTransitionPlan, progress: number, rect: ViewportRect): ViewportTransitionFrame {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const { width, height } = getViewportSize(plan.baseSnapshot, rect);
  const scaleFactor = getScaleFactorFromPerspectiveDistance(plan.baseSnapshot, plan.perspectiveDistance, height);
  const unitsPerPixel = getUnitsPerPixel(plan.baseSnapshot.gridSpacing, scaleFactor);
  const viewAngle = interpolateTransitionViewAngle(plan, clampedProgress);
  const target =
    plan.direction === "to2d"
      ? {
          x: lerp(plan.startTarget.x, plan.endTarget.x, clampedProgress),
          y: lerp(plan.startTarget.y, plan.endTarget.y, clampedProgress),
          z: lerp(plan.startTarget.z, plan.endTarget.z, clampedProgress),
        }
      : { ...plan.startTarget };
  const pose = buildPerspectivePoseFromViewAngle(viewAngle, plan.perspectiveDistance, target);

  return {
    viewAngle,
    target,
    pose,
    snapshot: {
      ...plan.baseSnapshot,
      mode: "3d",
      width,
      height,
      scaleFactor,
      unitsPerPixel,
      transitionZMultiplier: plan.direction === "to2d" ? 1 - clampedProgress : clampedProgress,
      target,
      orthographic: orthographicFor(width, height, unitsPerPixel, target),
      perspective: {
        ...plan.baseSnapshot.perspective,
        aspect: width / Math.max(1, height),
        position: { ...pose.position },
        up: { ...pose.up },
      },
    },
  };
}

export function getViewportVisibleCenterCanvasPoint(rect: ViewportRect, sidebarWidth: number): PointXY {
  const width = rect.width || 1;
  const height = rect.height || 1;
  return {
    x: sidebarWidth + (width - sidebarWidth) / 2,
    y: height / 2,
  };
}

function buildViewport2DStateFromVisibleCenter(visibleCenter: PointXY, scaleFactor: number, gridSpacing: number): Viewport2DState {
  return {
    gridSpacing,
    scaleFactor: clampScaleFactor2D(scaleFactor),
    offsetX: -visibleCenter.x,
    offsetY: -visibleCenter.y,
  };
}

export function buildViewport2DStateFromTransitionFrame(plan: ViewportTransitionPlan, frame: ViewportTransitionFrame, rect: ViewportRect, sidebarWidth: number): Viewport2DState {
  const visibleCenter = projectCanvasPointToWorldPlane(frame.snapshot, rect, getViewportVisibleCenterCanvasPoint(rect, sidebarWidth), plan.endTarget.z) ?? {
    x: frame.target.x,
    y: frame.target.y,
  };

  return buildViewport2DStateFromVisibleCenter(visibleCenter, frame.snapshot.scaleFactor, frame.snapshot.gridSpacing);
}
