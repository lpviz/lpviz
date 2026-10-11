// Which drawn thing a pointer position is on: vertices, edges, boundary rays, the objective tip
// and the start marker, in screen or world tolerances as each one needs.

import type { State } from "@/features/core/store";
import { getEditorContext } from "@/features/polytope-editor/editorSession";
import type { DragTarget } from "@/features/polytope-editor/editorState";
import { displayedSolverStartPoint, iterateHeight } from "@/features/solver/solverState";
import type { ViewportApi } from "@/features/viewport/runtime";
import { showsDepth } from "@/features/viewport/viewportState";
import { clipRayToBoundingBox } from "@lpviz/math/bounds";
import { distanceToSegment, nearestEdge } from "@lpviz/math/polygon";
import type { Constraint, PointXY, PointXYZ, Vec } from "@lpviz/math/types";

const VERTEX_HIT_RADIUS_PX = 12;
const OBJECTIVE_TIP_HIT_RADIUS_PX = 10;
// tighter than the vertex radius: in simplex mode the marker sits on a
// vertex, and grabbing just outside the ring must still drag the vertex
const SOLVER_START_HIT_RADIUS_PX = 10;
// How close, on screen, a pointer must be to an edge to pick it. Edges are
// tested in world units, so callers convert this with worldDistanceForPixels;
// a fixed world tolerance was hundreds of pixels wide zoomed in on a small
// region and under a pixel zoomed out (see #71).
export const EDGE_HIT_RADIUS_PX = 10;
const DRAG_THRESHOLD_PX = 5;

export type ConstraintDragTarget = Extract<DragTarget, { kind: "constraint" }>;

/** The pointer's position on the canvas, in CSS pixels from its top-left corner. */
export function getCanvasFromClient(viewportApi: ViewportApi, clientX: number, clientY: number): PointXY {
  const rect = viewportApi.getCanvasRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

export function getLogicalFromClient(viewportApi: ViewportApi, clientX: number, clientY: number): Vec {
  const canvasPoint = getCanvasFromClient(viewportApi, clientX, clientY);
  const { x, y } = viewportApi.toLogicalCoords(canvasPoint.x, canvasPoint.y);
  return [x, y];
}

// whether the world point (drawn at height z) is within `radiusPx` of the canvas point on screen
function withinRadiusPx(viewportApi: ViewportApi, canvasPoint: PointXY, world: Vec, radiusPx: number, z?: number): boolean {
  const drawn = viewportApi.toCanvasCoords(world[0], world[1], z);
  return Math.hypot(canvasPoint.x - drawn.x, canvasPoint.y - drawn.y) <= radiusPx;
}

export function findVertexNearCanvasPoint(viewportApi: ViewportApi, canvasPoint: PointXY, vertices: Vec[]): number {
  return vertices.findIndex((vertex) => withinRadiusPx(viewportApi, canvasPoint, vertex, VERTEX_HIT_RADIUS_PX));
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

/** The boundary ray within an edge's screen radius of `point`, as the index into the polytope's rays. */
export function findBoundaryRayNearPoint(viewportApi: ViewportApi, state: State, point: Vec): number | null {
  const { completionMode, polytope } = state;
  if (completionMode !== "open" || !polytope?.boundaryRays?.length) return null;

  // the rays are clipped to the (padded) visible rect only to be tested as segments
  const bounds = viewportApi.getVisibleBounds();
  const tolerance = worldDistanceForPixels(viewportApi, point, EDGE_HIT_RADIUS_PX);
  for (let index = 0; index < polytope.boundaryRays.length; index++) {
    const clipped = clipRayToBoundingBox(polytope.boundaryRays[index]!, bounds);
    if (!clipped) continue;
    const [start, end] = clipped;
    if (distanceToSegment(point, start, end) < tolerance) return index;
  }
  return null;
}

// the drag's anchor in 3D: the grabbed point, whose view-aligned plane catches pointer rays that miss the floor
function getViewAnchor3D(state: State, point: Vec): PointXYZ | undefined {
  return showsDepth(state) ? { x: point[0], y: point[1], z: point[2] ?? 0 } : undefined;
}

export function getDragStartTarget(viewportApi: ViewportApi, state: State, clientX: number, clientY: number): DragTarget | null {
  const logicalCoords = getLogicalFromClient(viewportApi, clientX, clientY);
  const canvasPoint = getCanvasFromClient(viewportApi, clientX, clientY);
  const { session } = getEditorContext(state);
  const edgeTolerance = worldDistanceForPixels(viewportApi, logicalCoords, EDGE_HIT_RADIUS_PX);
  const vertexTarget = (): DragTarget | null => {
    const index = findVertexNearCanvasPoint(viewportApi, canvasPoint, state.vertices);
    if (index === -1) return null;
    const vertex = state.vertices[index];
    return { kind: "point", index, viewAnchor3D: vertex ? getViewAnchor3D(state, vertex) : undefined };
  };

  if (session === "drafting") return vertexTarget();

  if (state.objectiveVector && withinRadiusPx(viewportApi, canvasPoint, state.objectiveVector, OBJECTIVE_TIP_HIT_RADIUS_PX)) {
    return { kind: "objective", viewAnchor3D: getViewAnchor3D(state, state.objectiveVector) };
  }

  const startPoint = solverStartNearCanvasPoint(viewportApi, state, canvasPoint);
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

  if (session === "editing-closed" && state.vertices.length >= 3) {
    const edgeIndex = nearestEdge(state.vertices, logicalCoords, edgeTolerance);
    if (edgeIndex === null) return null;
    const start = state.vertices[edgeIndex]!;
    const end = state.vertices[(edgeIndex + 1) % state.vertices.length]!;
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) <= 1e-6) return null;
    return constraintTarget({ kind: "closed-line", lineIndex: edgeIndex, constraints }, constraints[edgeIndex]);
  }

  if (session === "editing-open" && state.vertices.length >= 2) {
    const edgeIndex = nearestEdge(state.vertices, logicalCoords, edgeTolerance, false);
    if (edgeIndex !== null) return constraintTarget({ kind: "open-vertices", vertexIndices: [edgeIndex, edgeIndex + 1] }, constraints[edgeIndex]);

    const rayIndex = findBoundaryRayNearPoint(viewportApi, state, logicalCoords);
    if (rayIndex === null) return null;
    // the first ray continues the chain's first edge, the last ray its last edge
    const last = state.vertices.length - 1;
    return constraintTarget({ kind: "open-vertices", vertexIndices: rayIndex === 0 ? [0, 1] : [last - 1, last] }, constraints[rayIndex === 0 ? 0 : constraints.length - 1]);
  }

  return null;
}

export function solverStartNearCanvasPoint(viewportApi: ViewportApi, state: State, canvasPoint: PointXY): Vec | null {
  const startPoint = displayedSolverStartPoint(state);
  if (!startPoint) return null;
  // project at the marker's drawn height: in 3D the ring rides at the first
  // iterate's height, matching SolverStartLayer
  const { iteratePath } = state;
  const z = iteratePath.count > 0 ? iterateHeight(iteratePath, 0) : undefined;
  return withinRadiusPx(viewportApi, canvasPoint, startPoint, SOLVER_START_HIT_RADIUS_PX, z) ? startPoint : null;
}

export function exceedsDragThreshold(state: State, clientX: number, clientY: number): boolean {
  const editorInteraction = state.editorInteraction;
  const dragStartPos = editorInteraction.kind === "pending-drag" ? editorInteraction.dragStartPos : null;
  if (!dragStartPos) return false;
  return Math.hypot(clientX - dragStartPos.x, clientY - dragStartPos.y) > DRAG_THRESHOLD_PX;
}
