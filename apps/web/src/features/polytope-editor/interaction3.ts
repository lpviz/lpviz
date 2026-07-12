import type { State } from "@/features/core/store";
import type { ViewportApi } from "@/features/viewport/runtime";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import type { PointXY, PointXYZ } from "@lpviz/math/types";
import { buildPointerRay3D, closestLineParamToRay, intersectRayWithViewPlane, pickPolytopeFace, type FacePick, type PointerRay3D } from "@lpviz/viewport/picking3d";
import { projectWorldPosition3D } from "@lpviz/viewport/projection3d";

// Screen-space hit radii (px), matching the 2D editor's feel.
const HANDLE_HIT_RADIUS = 16;
const VERTEX3_HIT_RADIUS = 14;
const OBJECTIVE3_TIP_RADIUS = 14;
const MAX_EXTRUDE_HEIGHT = 200;

// In /3d the problem's z is a real coordinate: zScale is pinned to 100 so
// layers render world z verbatim (scale.z = zScale/100 = 1) and these screen
// projections agree with the drawn geometry.
function pointerRayFromClient(canvasManager: ViewportApi, clientX: number, clientY: number): PointerRay3D | null {
  const rect = canvasManager.getCanvasRect();
  return buildPointerRay3D(getViewportRenderSnapshot(), rect, clientX - rect.left, clientY - rect.top);
}

function projectWorldToLocal(canvasManager: ViewportApi, position: PointXYZ): PointXY {
  return projectWorldPosition3D(getViewportRenderSnapshot(), canvasManager.getCanvasRect(), position);
}

export function findFaceAtClient(canvasManager: ViewportApi, state: State, clientX: number, clientY: number): FacePick | null {
  if (state.planes.length === 0) return null;
  const ray = pointerRayFromClient(canvasManager, clientX, clientY);
  if (!ray) return null;
  return pickPolytopeFace(ray, state.planes);
}

export function findVertex3NearClient(canvasManager: ViewportApi, vertices: PointXYZ[], clientX: number, clientY: number): number {
  const rect = canvasManager.getCanvasRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  let bestIndex = -1;
  let bestDistance = VERTEX3_HIT_RADIUS;
  for (let i = 0; i < vertices.length; i++) {
    const screen = projectWorldToLocal(canvasManager, vertices[i]!);
    const distance = Math.hypot(localX - screen.x, localY - screen.y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// Matches ExtrudeHandleLayer's resting arrow length so the hit area always
// covers the drawn handle.
const EXTRUDE_HANDLE_IDLE_LENGTH_PX = 48;

// Extrude handle = vertical arrow from the base centroid up to the preview
// height. Hit anywhere along the projected shaft (segment distance test).
export function isExtrudeHandleAtClient(canvasManager: ViewportApi, base: PointXYZ, height: number, clientX: number, clientY: number): boolean {
  const rect = canvasManager.getCanvasRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const idleLength = EXTRUDE_HANDLE_IDLE_LENGTH_PX * getViewportRenderSnapshot().unitsPerPixel;
  const bottom = projectWorldToLocal(canvasManager, base);
  const top = projectWorldToLocal(canvasManager, {
    x: base.x,
    y: base.y,
    z: Math.max(height, idleLength),
  });
  const dx = top.x - bottom.x;
  const dy = top.y - bottom.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((localX - bottom.x) * dx + (localY - bottom.y) * dy) / lengthSq)) : 0;
  const px = bottom.x + t * dx;
  const py = bottom.y + t * dy;
  return Math.hypot(localX - px, localY - py) <= HANDLE_HIT_RADIUS;
}

export function heightFromPointer(canvasManager: ViewportApi, base: PointXYZ, clientX: number, clientY: number): number | null {
  const ray = pointerRayFromClient(canvasManager, clientX, clientY);
  if (!ray) return null;
  const t = closestLineParamToRay(ray, { x: base.x, y: base.y, z: 0 }, { x: 0, y: 0, z: 1 });
  if (t === null) return null;
  return Math.max(0, Math.min(MAX_EXTRUDE_HEIGHT, t));
}

// New face offset for a push/pull drag: parameter along the normal line
// through the drag's anchor point (which lies on the face, so n·anchor = d0).
export function faceOffsetFromPointer(canvasManager: ViewportApi, anchorPoint: PointXYZ, normal: PointXYZ, anchorD: number, clientX: number, clientY: number): number | null {
  const ray = pointerRayFromClient(canvasManager, clientX, clientY);
  if (!ray) return null;
  const t = closestLineParamToRay(ray, anchorPoint, normal);
  if (t === null) return null;
  return anchorD + t;
}

const EDGE3_HIT_RADIUS = 10;

// Nearest solid edge to the pointer in screen space (projected point-to-
// segment distance), or -1. Used for double-click edge bevels.
export function findEdge3NearClient(canvasManager: ViewportApi, vertices: PointXYZ[], edges: { a: number; b: number }[], clientX: number, clientY: number): number {
  const rect = canvasManager.getCanvasRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  let bestIndex = -1;
  let bestDistance = EDGE3_HIT_RADIUS;
  for (let i = 0; i < edges.length; i++) {
    const a = vertices[edges[i]!.a];
    const b = vertices[edges[i]!.b];
    if (!a || !b) continue;
    const pa = projectWorldToLocal(canvasManager, a);
    const pb = projectWorldToLocal(canvasManager, b);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((localX - pa.x) * dx + (localY - pa.y) * dy) / lengthSq)) : 0;
    const distance = Math.hypot(localX - (pa.x + t * dx), localY - (pa.y + t * dy));
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

export function isObjective3TipAtClient(canvasManager: ViewportApi, tip: PointXYZ, clientX: number, clientY: number): boolean {
  const rect = canvasManager.getCanvasRect();
  const screen = projectWorldToLocal(canvasManager, tip);
  return Math.hypot(clientX - rect.left - screen.x, clientY - rect.top - screen.y) <= OBJECTIVE3_TIP_RADIUS;
}

// Free 3D point under the pointer, on the camera-facing plane through
// `anchor` — used to aim the objective arrow and drag corner vertices.
export function objectivePointFromPointer(canvasManager: ViewportApi, anchor: PointXYZ, clientX: number, clientY: number): PointXYZ | null {
  const ray = pointerRayFromClient(canvasManager, clientX, clientY);
  if (!ray) return null;
  return intersectRayWithViewPlane(ray, getViewportRenderSnapshot(), anchor);
}

// Point on the line (anchor + t·axis) nearest the pointer ray — axis-locked
// dragging (face-inserted vertex handles follow their face's normal).
export function constrainedPointFromPointer(canvasManager: ViewportApi, anchor: PointXYZ, axis: PointXYZ, clientX: number, clientY: number): PointXYZ | null {
  const ray = pointerRayFromClient(canvasManager, clientX, clientY);
  if (!ray) return null;
  const t = closestLineParamToRay(ray, anchor, axis);
  if (t === null) return null;
  return { x: anchor.x + axis.x * t, y: anchor.y + axis.y * t, z: anchor.z + axis.z * t };
}
