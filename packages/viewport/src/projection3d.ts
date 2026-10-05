import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from "three";

import type { PointXY, PointXYZ } from "@lpviz/math/types";
import { getViewportSize, snapPoint, type ViewportRect, type ViewportRenderSnapshot } from "./types";

export type Viewport3DInteractionOptions = {
  zScale: number;
  snapToGrid: boolean;
  editorInteractionKind: string;
  is3DMode: boolean;
  isTransitioning3D: boolean;
  viewAnchor3D?: { x: number; y: number; z: number };
};

const MAX_3D_DRAG_BOUND = 5000;
const VIEW_DRAG_BOUND_MULTIPLIER = 6;
const MAX_3D_PLANE_SLOPE = 2;
// Ray-plane denominator threshold: if |ray · normal| < this, the ray is nearly
// parallel to the plane and the intersection point is too far away to be useful.
const PLANE_PARALLEL_THRESHOLD = 0.08;
const Z_PLANE_NORMAL: PointXYZ = { x: 0, y: 0, z: 1 };

const projectionCamera = new PerspectiveCamera();
const projectionTarget = new Vector3();
const projectionRaycaster = new Raycaster();
const projectionPointerNdc = new Vector2();
const projectionPointerWorld = new Vector3();
const projectionPlaneNormal = new Vector3();
const projectionPlanePoint = new Vector3();
const projectionPlane = new Plane();
const projectedPosition = new Vector3();
const projectionViewDir = new Vector3();

// The package's one scratch camera, posed from the snapshot; every reader
// configures it first and nothing relies on its state across calls.
// Defaults to the package's scratch camera; callers that own a camera pass it and the Vector3 that should hold the target.
export function configurePerspectiveCameraFromSnapshot(snapshot: ViewportRenderSnapshot, camera = projectionCamera, target = projectionTarget): PerspectiveCamera {
  camera.fov = snapshot.perspective.fov;
  camera.aspect = snapshot.perspective.aspect;
  camera.near = snapshot.perspective.near;
  camera.far = snapshot.perspective.far;
  camera.position.set(snapshot.perspective.position.x, snapshot.perspective.position.y, snapshot.perspective.position.z);
  camera.up.set(snapshot.perspective.up.x, snapshot.perspective.up.y, snapshot.perspective.up.z);
  camera.lookAt(target.set(snapshot.target.x, snapshot.target.y, snapshot.target.z));
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

export function getPerspectiveDistanceFromSnapshot3D(snapshot: ViewportRenderSnapshot) {
  return projectedPosition
    .set(snapshot.perspective.position.x, snapshot.perspective.position.y, snapshot.perspective.position.z)
    .distanceTo(projectionTarget.set(snapshot.target.x, snapshot.target.y, snapshot.target.z));
}

const clamp3DInteractionPoint = (point: PointXY, snapshot: ViewportRenderSnapshot, rect: ViewportRect, options: Viewport3DInteractionOptions): PointXY => {
  if (!(options.editorInteractionKind !== "idle" && (options.is3DMode || options.isTransitioning3D))) {
    return point;
  }

  const { width, height } = getViewportSize(snapshot, rect);
  const viewSpan = Math.max(width, height) * snapshot.unitsPerPixel;
  const viewBound = Math.max(60, viewSpan * VIEW_DRAG_BOUND_MULTIPLIER);
  const slopeScaler = Math.max(options.zScale, 0.001);
  const slopeBound = (MAX_3D_PLANE_SLOPE * 100) / slopeScaler;
  const bound = Math.min(MAX_3D_DRAG_BOUND, Math.min(viewBound, slopeBound));
  if (!Number.isFinite(bound) || bound <= 0) {
    return point;
  }

  return {
    x: Math.max(snapshot.target.x - bound, Math.min(snapshot.target.x + bound, point.x)),
    y: Math.max(snapshot.target.y - bound, Math.min(snapshot.target.y + bound, point.y)),
  };
};

// Far-offscreen sentinel for points that have no on-screen position; finite
// so distance-based hit tests against it are well-defined and never match.
const OFFSCREEN_CANVAS_COORD = -1e9;

export function projectWorldPosition3D(snapshot: ViewportRenderSnapshot, rect: ViewportRect, position: { x: number; y: number; z: number }): PointXY {
  configurePerspectiveCameraFromSnapshot(snapshot);
  const { width, height } = getViewportSize(snapshot, rect);
  projectedPosition.set(position.x, position.y, position.z).applyMatrix4(projectionCamera.matrixWorldInverse);
  if (projectedPosition.z >= 0) {
    // Behind the camera: projecting would mirror the point onto the screen,
    // making it spuriously hoverable/draggable.
    return { x: OFFSCREEN_CANVAS_COORD, y: OFFSCREEN_CANVAS_COORD };
  }
  projectedPosition.applyMatrix4(projectionCamera.projectionMatrix);

  return {
    x: ((projectedPosition.x + 1) / 2) * width,
    y: ((1 - projectedPosition.y) / 2) * height,
  };
}

export function toCanvasCoords3D(
  snapshot: ViewportRenderSnapshot,
  rect: ViewportRect,
  point: PointXY,
  z: number | undefined,
  zScale: number,
  zValueForPoint?: (entry: Float64Array) => number,
): PointXY {
  const entry = z === undefined ? Float64Array.of(point.x, point.y) : Float64Array.of(point.x, point.y, z);
  const zValue = zValueForPoint ? zValueForPoint(entry) : (z ?? 0);
  // Render layers flatten z by transitionZMultiplier during the 2D/3D
  // transition; match them so screen positions agree with drawn geometry.
  return projectWorldPosition3D(snapshot, rect, {
    x: point.x,
    y: point.y,
    z: ((zValue * zScale) / 100) * snapshot.transitionZMultiplier,
  });
}

// Where the ray through canvas-space `point` meets the plane, or null when the
// ray is near-parallel to it (the hit would be billions of units away: test
// the denominator ray · normal first), misses it, or hits at a non-finite
// point.
function intersectCanvasRayWithPlane(snapshot: ViewportRenderSnapshot, rect: ViewportRect, point: PointXY, normal: PointXYZ, coplanarPoint: PointXYZ): PointXY | null {
  const { width, height } = getViewportSize(snapshot, rect);
  projectionRaycaster.setFromCamera(projectionPointerNdc.set((point.x / width) * 2 - 1, -((point.y / height) * 2 - 1)), configurePerspectiveCameraFromSnapshot(snapshot));
  projectionPlane.setFromNormalAndCoplanarPoint(projectionPlaneNormal.set(normal.x, normal.y, normal.z), projectionPlanePoint.set(coplanarPoint.x, coplanarPoint.y, coplanarPoint.z));
  if (Math.abs(projectionRaycaster.ray.direction.dot(projectionPlane.normal)) < PLANE_PARALLEL_THRESHOLD) return null;
  const hit = projectionRaycaster.ray.intersectPlane(projectionPlane, projectionPointerWorld);
  return hit && Number.isFinite(projectionPointerWorld.x) && Number.isFinite(projectionPointerWorld.y) ? { x: projectionPointerWorld.x, y: projectionPointerWorld.y } : null;
}

export function projectCanvasPointToWorldPlane(snapshot: ViewportRenderSnapshot, rect: ViewportRect, point: PointXY, z = 0): PointXY | null {
  return intersectCanvasRayWithPlane(snapshot, rect, point, Z_PLANE_NORMAL, { x: 0, y: 0, z });
}

export function toLogicalCoords3D(snapshot: ViewportRenderSnapshot, rect: ViewportRect, x: number, y: number, options: Viewport3DInteractionOptions): PointXY {
  let point = projectCanvasPointToWorldPlane(snapshot, rect, { x, y });
  if (!point && options.viewAnchor3D) {
    // Fallback: the view-aligned plane through the drag anchor. It is always
    // well-conditioned because its normal points toward the camera, so the
    // ray can never be parallel to it for reasonable FOVs.
    const viewDir = projectionViewDir
      .set(snapshot.target.x - snapshot.perspective.position.x, snapshot.target.y - snapshot.perspective.position.y, snapshot.target.z - snapshot.perspective.position.z)
      .normalize();
    point = intersectCanvasRayWithPlane(snapshot, rect, { x, y }, viewDir, options.viewAnchor3D);
  }
  return snapPoint(clamp3DInteractionPoint(point ?? { x: snapshot.target.x, y: snapshot.target.y }, snapshot, rect, options), options.snapToGrid);
}
