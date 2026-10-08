// The perspective camera's geometry: how far it stands from its target for a given zoom, and the
// pose a view angle puts it in.

import { Euler, Vector3 } from "three";

import type { PointXYZ } from "@lpviz/math/types";
import { MIN_PERSPECTIVE_DISTANCE } from "./defaults";
import { clampScaleFactor2D } from "./projection2d";
import type { ViewportPerspectivePose, ViewportRenderSnapshot } from "./snapshot";

const DEGREES_TO_RADIANS = Math.PI / 180;

const basisEuler = new Euler();
const basisForward = new Vector3();
const basisUp = new Vector3();
const basisRight = new Vector3();
const posePosition = new Vector3();
const distancePosition = new Vector3();
const distanceTarget = new Vector3();

/** tan of half the vertical field of view: the view's half-height at unit depth. */
export const tanHalfVerticalFov = (snapshot: ViewportRenderSnapshot) => Math.tan((snapshot.perspective.fov * DEGREES_TO_RADIANS) / 2);

/** World units per pixel at `distance` in front of the camera, for a viewport `height` pixels tall. */
export function unitsPerPixelAtDistance(snapshot: ViewportRenderSnapshot, distance: number, height: number) {
  return (2 * tanHalfVerticalFov(snapshot) * Math.max(MIN_PERSPECTIVE_DISTANCE, distance)) / Math.max(1, height);
}

/** The camera distance at which the target plane shows `unitsPerPixel`. */
export function getPerspectiveDistanceForUnitsPerPixel(snapshot: ViewportRenderSnapshot, unitsPerPixel: number, height = snapshot.height || 1) {
  return Math.max(MIN_PERSPECTIVE_DISTANCE, (height * unitsPerPixel) / (2 * tanHalfVerticalFov(snapshot)));
}

/** The 2D scale factor that shows the target plane at the same zoom as a camera at `distance`. */
export function getScaleFactorFromPerspectiveDistance(snapshot: ViewportRenderSnapshot, distance: number, height = snapshot.height || 1) {
  return clampScaleFactor2D(1 / (unitsPerPixelAtDistance(snapshot, distance, height) * snapshot.gridSpacing));
}

export function getPerspectiveDistanceFromSnapshot3D(snapshot: ViewportRenderSnapshot) {
  return distancePosition
    .set(snapshot.perspective.position.x, snapshot.perspective.position.y, snapshot.perspective.position.z)
    .distanceTo(distanceTarget.set(snapshot.target.x, snapshot.target.y, snapshot.target.z));
}

/**
 * The camera frame a view angle describes, on the package's scratch vectors (valid until the next
 * call): `forward` points from the target to the camera, `up` is the camera's up, `right` completes
 * the frame.
 */
export function viewAngleBasis(viewAngle: PointXYZ): { forward: Vector3; up: Vector3; right: Vector3 } {
  basisEuler.set(-viewAngle.x, -viewAngle.y, -viewAngle.z, "XYZ");
  basisForward.set(0, 0, 1).applyEuler(basisEuler).normalize();
  basisUp.set(0, 1, 0).applyEuler(basisEuler).normalize();
  basisRight.crossVectors(basisUp, basisForward).normalize();
  return { forward: basisForward, up: basisUp, right: basisRight };
}

/** The camera `distance` away from `target` along the view angle. */
export function buildPerspectivePoseFromViewAngle(viewAngle: PointXYZ, distance: number, target: PointXYZ): ViewportPerspectivePose {
  const { forward, up } = viewAngleBasis(viewAngle);
  posePosition.set(target.x, target.y, target.z).addScaledVector(forward, Math.max(MIN_PERSPECTIVE_DISTANCE, distance));
  return {
    position: { x: posePosition.x, y: posePosition.y, z: posePosition.z },
    up: { x: up.x, y: up.y, z: up.z },
    target: { x: target.x, y: target.y, z: target.z },
  };
}
