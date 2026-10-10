// The animated switch between the 2D and 3D views: a plan fixed when it starts, and the frame
// (view angle, pose and snapshot) at any progress along it.

import type { PointXYZ } from "@lpviz/math/types";
import { DEFAULT_VIEW_ANGLE, MIN_PERSPECTIVE_DISTANCE } from "./defaults";
import { buildPerspectivePoseFromViewAngle, getPerspectiveDistanceForUnitsPerPixel, getPerspectiveDistanceFromSnapshot3D, getScaleFactorFromPerspectiveDistance } from "./perspective";
import { clampScaleFactor2D, type Viewport2DState } from "./projection2d";
import { projectCanvasPointToWorldPlane } from "./projection3d";
import { getViewportSize, getViewportVisibleCenterCanvasPoint, orthographicFor, type ViewportPerspectivePose, type ViewportRect, type ViewportRenderSnapshot } from "./snapshot";

type ViewportTransitionDirection = "to3d" | "to2d";

export type ViewportTransitionPlan = {
  baseSnapshot: ViewportRenderSnapshot;
  direction: ViewportTransitionDirection;
  /** milliseconds */
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

const TRANSITION_TO_3D_MS = 400;
const TRANSITION_TO_2D_MS = 500;
const ZERO_VIEW_ANGLE: PointXYZ = { x: 0, y: 0, z: 0 };
const lerp = (start: number, end: number, t: number) => start + (end - start) * t;
const lerpPoint = (start: PointXYZ, end: PointXYZ, t: number): PointXYZ => ({ x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t), z: lerp(start.z, end.z, t) });

/** Plan the switch from `snapshot` to 3D (`targetMode` true) or back to 2D, from the current 3D `viewAngle`. */
export function buildViewportTransitionPlan({ snapshot, targetMode, viewAngle }: { snapshot: ViewportRenderSnapshot; targetMode: boolean; viewAngle: PointXYZ }): ViewportTransitionPlan {
  const startTarget = { x: snapshot.target.x, y: snapshot.target.y, z: snapshot.target.z };
  const snapshotDistance = getPerspectiveDistanceFromSnapshot3D(snapshot);
  return {
    baseSnapshot: snapshot,
    direction: targetMode ? "to3d" : "to2d",
    duration: targetMode ? TRANSITION_TO_3D_MS : TRANSITION_TO_2D_MS,
    startAngles: targetMode ? { ...ZERO_VIEW_ANGLE } : { ...viewAngle },
    endAngles: targetMode ? { ...DEFAULT_VIEW_ANGLE } : { ...ZERO_VIEW_ANGLE },
    startTarget,
    endTarget: { ...startTarget, z: targetMode ? startTarget.z : 0 },
    // a 3D view keeps its own distance on the way back; a 2D view takes the one that shows its zoom
    perspectiveDistance:
      !targetMode && Number.isFinite(snapshotDistance) && snapshotDistance > 0
        ? Math.max(MIN_PERSPECTIVE_DISTANCE, snapshotDistance)
        : getPerspectiveDistanceForUnitsPerPixel(snapshot, snapshot.unitsPerPixel, snapshot.height),
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

/** The 2D state that shows what a transition frame shows at the visible center, for the handoff to the 2D controls. */
export function buildViewport2DStateFromTransitionFrame(plan: ViewportTransitionPlan, frame: ViewportTransitionFrame, rect: ViewportRect, sidebarWidth: number): Viewport2DState {
  const visibleCenter = projectCanvasPointToWorldPlane(frame.snapshot, rect, getViewportVisibleCenterCanvasPoint(rect, sidebarWidth), plan.endTarget.z) ?? { x: frame.target.x, y: frame.target.y };
  return { gridSpacing: frame.snapshot.gridSpacing, scaleFactor: clampScaleFactor2D(frame.snapshot.scaleFactor), offsetX: -visibleCenter.x, offsetY: -visibleCenter.y };
}
