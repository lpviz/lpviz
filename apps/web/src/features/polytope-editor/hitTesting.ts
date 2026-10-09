// Which drawn thing a pointer position is on: vertices, edges, boundary rays, the objective tip
// and the start marker, in screen or world tolerances as each one needs.

import type { DragTarget, State } from "@/features/core/store";
import { displayedSolverStartPoint, getState, iterateHeight } from "@/features/core/store";
import { getEditorContext } from "@/features/polytope-editor/editorSession";
import type { ViewportApi } from "@/features/viewport/runtime";
import { type BoundingBox, clipRayToBoundingBox } from "@lpviz/math/bounds";
import { distanceToSegment, nearestEdge } from "@lpviz/math/polygon";
import type { Constraint, PointXY, PointXYZ, Vec } from "@lpviz/math/types";

const VERTEX_HIT_RADIUS = 12;
// tighter than the vertex radius: in simplex mode the marker sits on a
// vertex, and grabbing just outside the ring must still drag the vertex
const SOLVER_START_HIT_RADIUS = 10;
// How close, on screen, a pointer must be to an edge to pick it. Edges are
// tested in world units, so callers convert this with worldDistanceForPixels;
// a fixed world tolerance was hundreds of pixels wide zoomed in on a small
// region and under a pixel zoomed out (see #71).
export const EDGE_HIT_RADIUS_PX = 10;
const DRAG_THRESHOLD_PX = 5;

export type ConstraintDragTarget = Extract<DragTarget, { kind: "constraint" }>;

export function getLogicalFromClient(viewportApi: ViewportApi, clientX: number, clientY: number): Vec {
  const rect = viewportApi.getCanvasRect();
  const { x, y } = viewportApi.toLogicalCoords(clientX - rect.left, clientY - rect.top);
  return [x, y];
}

export function getLocalFromClient(viewportApi: ViewportApi, clientX: number, clientY: number): PointXY {
  const rect = viewportApi.getCanvasRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

export function findVertexNearLocalPoint(viewportApi: ViewportApi, localX: number, localY: number, vertices: Vec[]): number {
  return vertices.findIndex((vertex) => {
    const canvasPoint = viewportApi.toCanvasCoords(vertex[0], vertex[1]);
    return Math.hypot(localX - canvasPoint.x, localY - canvasPoint.y) <= VERTEX_HIT_RADIUS;
  });
}

/**
 * The world distance that `pixels` on screen spans at `worldPoint`. Hit tests
 * on world geometry take a world tolerance, and converting a pixel radius at
 * the pointer keeps the target the same size on screen at every zoom level —
 * a fixed world radius is unhittable zoomed out (the usual case on mobile)
 * and covers most of a small region zoomed in.
 */
export function worldDistanceForPixels(viewportApi: ViewportApi, worldPoint: Vec, pixels: number): number {
  const canvasPoint = viewportApi.toCanvasCoords(worldPoint[0], worldPoint[1]);
  const shifted = viewportApi.toLogicalCoords(canvasPoint.x + pixels, canvasPoint.y);
  return Math.hypot(shifted.x - worldPoint[0], shifted.y - worldPoint[1]);
}

function getVisibleBounds(viewportApi: ViewportApi): BoundingBox {
  const margin = 50;
  const topLeft = viewportApi.toLogicalCoords(-margin, -margin);
  const bottomRight = viewportApi.toLogicalCoords(window.innerWidth + margin, window.innerHeight + margin);
  return {
    minX: Math.min(topLeft.x, bottomRight.x) - margin,
    maxX: Math.max(topLeft.x, bottomRight.x) + margin,
    minY: Math.min(topLeft.y, bottomRight.y) - margin,
    maxY: Math.max(topLeft.y, bottomRight.y) + margin,
  };
}

export function findBoundaryRayNearPoint(viewportApi: ViewportApi, point: Vec): number | null {
  const { completionMode, polytope } = getState();
  if (completionMode !== "open" || !polytope?.boundaryRays?.length) {
    return null;
  }

  const bounds = getVisibleBounds(viewportApi);
  for (let index = 0; index < polytope.boundaryRays.length; index++) {
    const ray = polytope.boundaryRays[index]!;
    const clipped = clipRayToBoundingBox(ray, bounds);
    if (!clipped) continue;
    const [start, end] = clipped;
    if (distanceToSegment(point, start, end) < 0.5) {
      return index;
    }
  }
  return null;
}

// the drag's anchor in 3D: the grabbed point, whose view-aligned plane catches pointer rays that miss the floor
function getViewAnchor3D(state: State, point: Vec): PointXYZ | undefined {
  return state.is3DMode || state.isTransitioning3D ? { x: point[0], y: point[1], z: point[2] ?? 0 } : undefined;
}

export function getDragStartTarget(viewportApi: ViewportApi, state: State, clientX: number, clientY: number): DragTarget | null {
  const logicalCoords = getLogicalFromClient(viewportApi, clientX, clientY);
  const local = getLocalFromClient(viewportApi, clientX, clientY);
  const { session } = getEditorContext(state);
  const edgeTolerance = worldDistanceForPixels(viewportApi, logicalCoords, EDGE_HIT_RADIUS_PX);
  const vertexTarget = (): DragTarget | null => {
    const index = findVertexNearLocalPoint(viewportApi, local.x, local.y, state.vertices);
    if (index === -1) return null;
    const vertex = state.vertices[index];
    return { kind: "point", index, viewAnchor3D: vertex ? getViewAnchor3D(state, vertex) : undefined };
  };

  if (session.kind === "drafting") return vertexTarget();

  if (state.objectiveVector) {
    const tip = viewportApi.getObjectiveScreenPosition(state.objectiveVector);
    if (Math.hypot(local.x - tip.x, local.y - tip.y) < 10) {
      return { kind: "objective", viewAnchor3D: getViewAnchor3D(state, state.objectiveVector) };
    }
  }

  const startPoint = solverStartNearLocalPoint(viewportApi, state, local.x, local.y);
  if (startPoint) {
    return {
      kind: "solver-start",
      grabOffset: [startPoint[0] - logicalCoords[0], startPoint[1] - logicalCoords[1]],
      viewAnchor3D: getViewAnchor3D(state, startPoint),
    };
  }

  const vertex = vertexTarget();
  if (vertex) return vertex;

  const constraints = state.polytope?.constraints;
  if (!constraints || constraints.length === 0) return null;
  // the drag shifts one constraint and re-derives the vertices from the whole set, which it
  // never mutates (see applyConstraintDrag); the normal is the dragged constraint's
  const constraintTarget = (operation: ConstraintDragTarget["operation"], constraint: Constraint | undefined): DragTarget | null =>
    constraint ? { kind: "constraint", operation, start: logicalCoords, normal: [constraint[0], constraint[1]] } : null;

  if (session.kind === "editing-closed" && state.vertices.length >= 3) {
    const edgeIndex = nearestEdge(state.vertices, logicalCoords, edgeTolerance);
    if (edgeIndex === null) return null;
    const start = state.vertices[edgeIndex]!;
    const end = state.vertices[(edgeIndex + 1) % state.vertices.length]!;
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) <= 1e-6) return null;
    return constraintTarget({ kind: "closed-line", lineIndex: edgeIndex, constraints }, constraints[edgeIndex]);
  }

  if (session.kind === "editing-open" && state.vertices.length >= 2) {
    const edgeIndex = nearestEdge(state.vertices, logicalCoords, edgeTolerance, false);
    if (edgeIndex !== null) return constraintTarget({ kind: "open-vertices", vertexIndices: [edgeIndex, edgeIndex + 1] }, constraints[edgeIndex]);

    const rayIndex = findBoundaryRayNearPoint(viewportApi, logicalCoords);
    if (rayIndex === null) return null;
    // the first ray continues the chain's first edge, the last ray its last edge
    const last = state.vertices.length - 1;
    return constraintTarget({ kind: "open-vertices", vertexIndices: rayIndex === 0 ? [0, 1] : [last - 1, last] }, constraints[rayIndex === 0 ? 0 : constraints.length - 1]);
  }

  return null;
}

export function solverStartNearLocalPoint(viewportApi: ViewportApi, state: State, localX: number, localY: number): Vec | null {
  const startPoint = displayedSolverStartPoint(state);
  if (!startPoint) return null;
  // project at the marker's drawn height: in 3D the ring rides at the first
  // iterate's height, matching SolverStartLayer
  const { iteratePath } = state;
  const z = iteratePath.count > 0 ? iterateHeight(iteratePath, 0) : undefined;
  const screen = viewportApi.toCanvasCoords(startPoint[0], startPoint[1], z);
  return Math.hypot(localX - screen.x, localY - screen.y) <= SOLVER_START_HIT_RADIUS ? startPoint : null;
}

export function exceedsDragThreshold(state: State, clientX: number, clientY: number): boolean {
  const editorInteraction = state.editorInteraction;
  const dragStartPos = editorInteraction.kind === "pending-drag" ? editorInteraction.dragStartPos : null;
  if (!dragStartPos) return false;
  return Math.hypot(clientX - dragStartPos.x, clientY - dragStartPos.y) > DRAG_THRESHOLD_PX;
}
