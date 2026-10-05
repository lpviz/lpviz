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

export const TRANSITION_VIEWPORT_DIRTY_FLAGS: ViewportDirtyFlags = { polytope: true, objective: true, trace: true, iterate: true };

const ZERO_VIEW_ANGLE: PointXYZ = { x: 0, y: 0, z: 0 };
const lerp = (start: number, end: number, t: number) => start + (end - start) * t;
const lerpPoint = (start: PointXYZ, end: PointXYZ, t: number): PointXYZ => ({ x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t), z: lerp(start.z, end.z, t) });

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
  const startTarget = { x: snapshot.target.x, y: snapshot.target.y, z: snapshot.target.z };
  const snapshotDistance = getPerspectiveDistanceFromSnapshot3D(snapshot);
  return {
    baseSnapshot: snapshot,
    direction: targetMode ? "to3d" : "to2d",
    duration: targetMode ? 400 : 500,
    startAngles: targetMode ? { ...ZERO_VIEW_ANGLE } : { ...viewAngle },
    endAngles: targetMode ? { ...DEFAULT_VIEW_ANGLE } : { ...ZERO_VIEW_ANGLE },
    startTarget,
    endTarget: { ...startTarget, z: targetMode ? startTarget.z : 0 },
    perspectiveDistance:
      !targetMode && Number.isFinite(snapshotDistance) && snapshotDistance > 0
        ? Math.max(10, snapshotDistance)
        : getPerspectiveDistanceForUnitsPerPixel(snapshot, snapshot.unitsPerPixel, snapshot.height),
  };
}

export function buildTransitionStartState(targetMode: boolean, startTime: number, plan: ViewportTransitionPlan) {
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

export function buildTransitionCompleteState(plan: ViewportTransitionPlan) {
  return { isTransitioning3D: false, transitionDirection: null, transitionProgress: 0, viewAngle: { ...plan.endAngles } };
}

export function buildPerspectivePoseFromViewAngle(viewAngle: PointXYZ, distance: number, target: PointXYZ): ViewportPerspectivePose {
  transitionEuler.set(-viewAngle.x, -viewAngle.y, -viewAngle.z, "XYZ");
  transitionDirection.set(0, 0, 1).applyEuler(transitionEuler).normalize();
  transitionPosition.set(target.x, target.y, target.z).add(transitionDirection.multiplyScalar(Math.max(10, distance)));
  transitionUp.set(0, 1, 0).applyEuler(transitionEuler).normalize();
  return {
    position: { x: transitionPosition.x, y: transitionPosition.y, z: transitionPosition.z },
    up: { x: transitionUp.x, y: transitionUp.y, z: transitionUp.z },
    target: { x: target.x, y: target.y, z: target.z },
  };
}

export function buildViewportTransitionFrame(plan: ViewportTransitionPlan, progress: number, rect: ViewportRect): ViewportTransitionFrame {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const { width, height } = getViewportSize(plan.baseSnapshot, rect);
  // already clamped by getScaleFactorFromPerspectiveDistance
  const scaleFactor = getScaleFactorFromPerspectiveDistance(plan.baseSnapshot, plan.perspectiveDistance, height);
  const unitsPerPixel = 1 / (plan.baseSnapshot.gridSpacing * scaleFactor);
  const viewAngle = lerpPoint(plan.startAngles, plan.endAngles, clampedProgress);
  const target = plan.direction === "to2d" ? lerpPoint(plan.startTarget, plan.endTarget, clampedProgress) : { ...plan.startTarget };
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
      perspective: { ...plan.baseSnapshot.perspective, aspect: width / Math.max(1, height), position: { ...pose.position }, up: { ...pose.up } },
    },
  };
}

export function getViewportVisibleCenterCanvasPoint(rect: ViewportRect, sidebarWidth: number): PointXY {
  return { x: sidebarWidth + ((rect.width || 1) - sidebarWidth) / 2, y: (rect.height || 1) / 2 };
}

export function buildViewport2DStateFromTransitionFrame(plan: ViewportTransitionPlan, frame: ViewportTransitionFrame, rect: ViewportRect, sidebarWidth: number): Viewport2DState {
  const visibleCenter = projectCanvasPointToWorldPlane(frame.snapshot, rect, getViewportVisibleCenterCanvasPoint(rect, sidebarWidth), plan.endTarget.z) ?? { x: frame.target.x, y: frame.target.y };
  return { gridSpacing: frame.snapshot.gridSpacing, scaleFactor: clampScaleFactor2D(frame.snapshot.scaleFactor), offsetX: -visibleCenter.x, offsetY: -visibleCenter.y };
}
