import type { CompletionMode, DragTarget, DragViewAnchor3D, State } from "@/features/core/store";
import { displayedSolverStartPoint, getState, iterateHeight } from "@/features/core/store";
import { getEditorContext } from "@/features/polytope-editor/editorSession";
import type { ViewportApi } from "@/features/viewport/runtime";
import { type BoundingBox, clipRayToBoundingBox, VRep } from "@lpviz/math/geometry";
import type { PointXY, Vec } from "@lpviz/math/types";

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

type Bounds = BoundingBox;

export type ConstraintDragTarget = Extract<DragTarget, { kind: "constraint" }>;

export function getLogicalFromClient(canvasManager: ViewportApi, clientX: number, clientY: number): Vec {
  const rect = canvasManager.getCanvasRect();
  const { x, y } = canvasManager.toLogicalCoords(clientX - rect.left, clientY - rect.top);
  return [x, y];
}

export function getLocalFromClient(canvasManager: ViewportApi, clientX: number, clientY: number): PointXY {
  const rect = canvasManager.getCanvasRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

export function findVertexNearLocalPoint(canvasManager: ViewportApi, localX: number, localY: number, vertices: Vec[]): number {
  return vertices.findIndex((vertex) => {
    const canvasPoint = canvasManager.toCanvasCoords(vertex[0], vertex[1]);
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
export function worldDistanceForPixels(canvasManager: ViewportApi, worldPoint: Vec, pixels: number): number {
  const canvasPoint = canvasManager.toCanvasCoords(worldPoint[0], worldPoint[1]);
  const shifted = canvasManager.toLogicalCoords(canvasPoint.x + pixels, canvasPoint.y);
  return Math.hypot(shifted.x - worldPoint[0], shifted.y - worldPoint[1]);
}

// The nearest edge within `tolerance` (world units); a draft or open chain
// has no closing edge.
export function findEdgeNearPoint(point: Vec, vertices: Vec[], completionMode: CompletionMode, tolerance = 0.5): number | null {
  return VRep.fromPoints(vertices).findEdgeNearPoint(point, tolerance, completionMode === "closed");
}

function getVisibleBounds(canvasManager: ViewportApi): Bounds {
  const margin = 50;
  const topLeft = canvasManager.toLogicalCoords(-margin, -margin);
  const bottomRight = canvasManager.toLogicalCoords(window.innerWidth + margin, window.innerHeight + margin);
  return {
    minX: Math.min(topLeft.x, bottomRight.x) - margin,
    maxX: Math.max(topLeft.x, bottomRight.x) + margin,
    minY: Math.min(topLeft.y, bottomRight.y) - margin,
    maxY: Math.max(topLeft.y, bottomRight.y) + margin,
  };
}

function distanceToSegment(point: Vec, start: Vec, end: Vec): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / len2));
  const projection = { x: start[0] + t * dx, y: start[1] + t * dy };
  return Math.hypot(point[0] - projection.x, point[1] - projection.y);
}

export function findBoundaryRayNearPoint(canvasManager: ViewportApi, point: Vec): number | null {
  const { completionMode, polytope } = getState();
  if (completionMode !== "open" || !polytope?.boundaryRays?.length) {
    return null;
  }

  const bounds = getVisibleBounds(canvasManager);
  for (let index = 0; index < polytope.boundaryRays.length; index++) {
    const ray = polytope.boundaryRays[index]!;
    const clipped = clipRayToBoundingBox(ray.start, ray.direction, bounds);
    if (!clipped) continue;
    const [start, end] = clipped;
    if (distanceToSegment(point, start, end) < 0.5) {
      return index;
    }
  }
  return null;
}

function getViewAnchor3D(state: State, point: Vec): DragViewAnchor3D | undefined {
  return state.is3DMode || state.isTransitioning3D ? { x: point[0], y: point[1], z: 0 } : undefined;
}

export function getDragStartTarget(canvasManager: ViewportApi, state: State, clientX: number, clientY: number): DragTarget | null {
  const logicalCoords = getLogicalFromClient(canvasManager, clientX, clientY);
  const local = getLocalFromClient(canvasManager, clientX, clientY);
  const { session } = getEditorContext(state);
  const edgeTolerance = worldDistanceForPixels(canvasManager, logicalCoords, EDGE_HIT_RADIUS_PX);
  const vertexTarget = (): DragTarget | null => {
    const index = findVertexNearLocalPoint(canvasManager, local.x, local.y, state.vertices);
    if (index === -1) return null;
    const vertex = state.vertices[index];
    return { kind: "point", index, viewAnchor3D: vertex ? getViewAnchor3D(state, vertex) : undefined };
  };

  if (session.kind === "drafting") return vertexTarget();

  if (state.objectiveVector) {
    const tip = canvasManager.getObjectiveScreenPosition(state.objectiveVector);
    if (Math.hypot(local.x - tip.x, local.y - tip.y) < 10) {
      return { kind: "objective", viewAnchor3D: getViewAnchor3D(state, state.objectiveVector) };
    }
  }

  const startPoint = solverStartNearLocalPoint(canvasManager, state, local.x, local.y);
  if (startPoint) {
    return {
      kind: "solver-start",
      grabOffset: [startPoint[0] - logicalCoords[0], startPoint[1] - logicalCoords[1]],
      viewAnchor3D: getViewAnchor3D(state, startPoint),
    };
  }

  const vertex = vertexTarget();
  if (vertex) return vertex;

  if (session.kind === "editing-closed" && state.vertices.length >= 3) {
    const polytope = VRep.fromPoints(state.vertices);
    const edgeIndex = polytope.findEdgeNearPoint(logicalCoords, edgeTolerance);
    if (edgeIndex !== null) {
      const lineContext = state.polytope?.lines;
      if (!lineContext || lineContext.length === 0) return null;
      const line = lineContext[edgeIndex];
      if (!line) return null;
      const nextIndex = (edgeIndex + 1) % state.vertices.length;
      const start = state.vertices[edgeIndex]!;
      const end = state.vertices[nextIndex]!;
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) > 1e-6) {
        return {
          kind: "constraint",
          operation: {
            kind: "closed-line",
            lineIndex: edgeIndex,
            lines: lineContext.map(([A, B, C]) => [A, B, C]),
          },
          start: logicalCoords,
          normal: [line[0], line[1]],
        };
      }
    }
  }

  if (session.kind === "editing-open" && state.vertices.length >= 2) {
    const lineContext = state.polytope?.lines;
    if (!lineContext || lineContext.length === 0) return null;

    const edgeIndex = findEdgeNearPoint(logicalCoords, state.vertices, "open", edgeTolerance);
    if (edgeIndex !== null) {
      const line = lineContext[edgeIndex];
      if (!line) return null;
      return {
        kind: "constraint",
        operation: {
          kind: "open-vertices",
          vertexIndices: [edgeIndex, edgeIndex + 1],
        },
        start: logicalCoords,
        normal: [line[0], line[1]],
      };
    }

    const rayIndex = findBoundaryRayNearPoint(canvasManager, logicalCoords);
    if (rayIndex === null) return null;

    const line = lineContext[rayIndex === 0 ? 0 : lineContext.length - 1];
    if (!line) return null;

    return {
      kind: "constraint",
      operation: {
        kind: "open-vertices",
        vertexIndices: rayIndex === 0 ? [0, 1] : [state.vertices.length - 2, state.vertices.length - 1],
      },
      start: logicalCoords,
      normal: [line[0], line[1]],
    };
  }

  return null;
}

export function solverStartNearLocalPoint(canvasManager: ViewportApi, state: State, localX: number, localY: number): Vec | null {
  const startPoint = displayedSolverStartPoint(state);
  if (!startPoint) return null;
  // project at the marker's drawn height: in 3D the ring rides at the first
  // iterate's height, matching SolverStartLayer
  const { iteratePath } = state;
  const z = iteratePath.count > 0 ? iterateHeight(iteratePath, 0) : undefined;
  const screen = canvasManager.toCanvasCoords(startPoint[0], startPoint[1], z);
  return Math.hypot(localX - screen.x, localY - screen.y) <= SOLVER_START_HIT_RADIUS ? startPoint : null;
}

export function exceedsDragThreshold(state: State, clientX: number, clientY: number): boolean {
  const editorInteraction = state.editorInteraction;
  const dragStartPos = editorInteraction.kind === "pending-drag" ? editorInteraction.dragStartPos : null;
  if (!dragStartPos) return false;
  return Math.hypot(clientX - dragStartPos.x, clientY - dragStartPos.y) > DRAG_THRESHOLD_PX;
}
