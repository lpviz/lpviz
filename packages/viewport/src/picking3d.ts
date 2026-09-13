import { PerspectiveCamera, Raycaster, Vector2, Vector3 } from "three";

import type { PointXYZ } from "@lpviz/math/types";
import type { ViewportRenderSnapshot } from "./types";

type ViewportRect = Pick<DOMRect, "width" | "height">;

// World-space pointer ray for true-3D picking (faces, handles, view planes).
// Unlike toLogicalCoords3D this preserves the full ray instead of collapsing
// to the ground plane, so callers can intersect arbitrary geometry.
export type PointerRay3D = {
  origin: PointXYZ;
  direction: PointXYZ;
};

const pickingCamera = new PerspectiveCamera();
const pickingTarget = new Vector3();
const pickingRaycaster = new Raycaster();
const pickingNdc = new Vector2();

export function buildPointerRay3D(snapshot: ViewportRenderSnapshot, rect: ViewportRect, x: number, y: number): PointerRay3D | null {
  const width = rect.width || snapshot.width || 0;
  const height = rect.height || snapshot.height || 0;
  if (width === 0 || height === 0) return null;

  pickingCamera.fov = snapshot.perspective.fov;
  pickingCamera.aspect = snapshot.perspective.aspect;
  pickingCamera.near = snapshot.perspective.near;
  pickingCamera.far = snapshot.perspective.far;
  pickingCamera.position.set(snapshot.perspective.position.x, snapshot.perspective.position.y, snapshot.perspective.position.z);
  pickingCamera.up.set(snapshot.perspective.up.x, snapshot.perspective.up.y, snapshot.perspective.up.z);
  pickingTarget.set(snapshot.target.x, snapshot.target.y, snapshot.target.z);
  pickingCamera.lookAt(pickingTarget);
  pickingCamera.updateMatrixWorld();
  pickingCamera.updateProjectionMatrix();

  pickingNdc.set((x / width) * 2 - 1, -((y / height) * 2 - 1));
  pickingRaycaster.setFromCamera(pickingNdc, pickingCamera);
  const ray = pickingRaycaster.ray;
  return {
    origin: { x: ray.origin.x, y: ray.origin.y, z: ray.origin.z },
    direction: { x: ray.direction.x, y: ray.direction.y, z: ray.direction.z },
  };
}

// Point on the line (linePoint + t·lineDir) closest to the ray. Used to drag
// along a fixed axis (extrude handle, face normal) regardless of view angle.
// Returns null when the ray and line are near-parallel (no stable solution).
export function closestLineParamToRay(ray: PointerRay3D, linePoint: PointXYZ, lineDir: PointXYZ): number | null {
  const u = ray.direction;
  const v = lineDir;
  const w = {
    x: linePoint.x - ray.origin.x,
    y: linePoint.y - ray.origin.y,
    z: linePoint.z - ray.origin.z,
  };
  const uu = u.x * u.x + u.y * u.y + u.z * u.z;
  const vv = v.x * v.x + v.y * v.y + v.z * v.z;
  const uv = u.x * v.x + u.y * v.y + u.z * v.z;
  const denominator = uu * vv - uv * uv;
  if (Math.abs(denominator) < 1e-9 * uu * vv) return null;
  const wu = w.x * u.x + w.y * u.y + w.z * u.z;
  const wv = w.x * v.x + w.y * v.y + w.z * v.z;
  // minimize |ray(s) - line(t)|²: s over the ray, t over the line
  return (uv * wu - uu * wv) / denominator;
}

// Ray hit against the camera-facing plane through `anchor` — the standard CAD
// trick for dragging a free 3D point with a 2D pointer.
export function intersectRayWithViewPlane(ray: PointerRay3D, snapshot: ViewportRenderSnapshot, anchor: PointXYZ): PointXYZ | null {
  const normal = {
    x: snapshot.target.x - snapshot.perspective.position.x,
    y: snapshot.target.y - snapshot.perspective.position.y,
    z: snapshot.target.z - snapshot.perspective.position.z,
  };
  const length = Math.hypot(normal.x, normal.y, normal.z);
  if (length < 1e-12) return null;
  normal.x /= length;
  normal.y /= length;
  normal.z /= length;
  const denominator = ray.direction.x * normal.x + ray.direction.y * normal.y + ray.direction.z * normal.z;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((anchor.x - ray.origin.x) * normal.x + (anchor.y - ray.origin.y) * normal.y + (anchor.z - ray.origin.z) * normal.z) / denominator;
  if (t <= 0) return null;
  return {
    x: ray.origin.x + ray.direction.x * t,
    y: ray.origin.y + ray.direction.y * t,
    z: ray.origin.z + ray.direction.z * t,
  };
}

export type FacePick = {
  planeIndex: number;
  point: PointXYZ;
  t: number;
};

// Nearest front hit of the pointer ray against a convex H-rep polytope
// (planes [a,b,c,d]: ax+by+cz <= d). A hit on plane i counts only when the
// hit point satisfies every other plane, i.e. it lies on the actual face.
export function pickPolytopeFace(ray: PointerRay3D, planes: number[][], tol = 1e-7): FacePick | null {
  let best: FacePick | null = null;
  for (let i = 0; i < planes.length; i++) {
    const plane = planes[i]!;
    const a = plane[0]!;
    const b = plane[1]!;
    const c = plane[2]!;
    const d = plane[3]!;
    const denominator = ray.direction.x * a + ray.direction.y * b + ray.direction.z * c;
    if (Math.abs(denominator) < 1e-12) continue;
    const t = (d - (ray.origin.x * a + ray.origin.y * b + ray.origin.z * c)) / denominator;
    if (t <= 0 || (best && t >= best.t)) continue;
    const point = {
      x: ray.origin.x + ray.direction.x * t,
      y: ray.origin.y + ray.direction.y * t,
      z: ray.origin.z + ray.direction.z * t,
    };
    let onFace = true;
    for (let j = 0; j < planes.length; j++) {
      if (j === i) continue;
      const other = planes[j]!;
      const margin = point.x * other[0]! + point.y * other[1]! + point.z * other[2]!;
      if (margin > other[3]! + tol * (1 + Math.abs(other[3]!))) {
        onFace = false;
        break;
      }
    }
    if (onFace) best = { planeIndex: i, point, t };
  }
  return best;
}
