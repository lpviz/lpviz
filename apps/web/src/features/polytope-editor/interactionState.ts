import type { CompletionMode, DragTarget, DragViewAnchor3D, State } from "@/features/core/store";
import { displayedSolverStartPoint, getState } from "@/features/core/store";
import { getEditorContext } from "@/features/polytope-editor/editorSession";
import type { ViewportApi } from "@/features/viewport/runtime";
import { type BoundingBox, clipRayToBoundingBox, VRep } from "@lpviz/math/geometry";
import type { PointXY } from "@lpviz/math/types";

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

export function getLogicalFromClient(canvasManager: ViewportApi, clientX: number, clientY: number): PointXY {
  const rect = canvasManager.getCanvasRect();
  return canvasManager.toLogicalCoords(clientX - rect.left, clientY - rect.top);
}

export function getLocalFromClient(canvasManager: ViewportApi, clientX: number, clientY: number): PointXY {
  const rect = canvasManager.getCanvasRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

export function findVertexNearLocalPoint(canvasManager: ViewportApi, localX: number, localY: number, vertices: PointXY[]): number {
  return vertices.findIndex((vertex) => {
    const canvasPoint = canvasManager.toCanvasCoords(vertex.x, vertex.y);
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
export function worldDistanceForPixels(canvasManager: ViewportApi, worldPoint: PointXY, pixels: number): number {
  const canvasPoint = canvasManager.toCanvasCoords(worldPoint.x, worldPoint.y);
  const shifted = canvasManager.toLogicalCoords(canvasPoint.x + pixels, canvasPoint.y);
  return Math.hypot(shifted.x - worldPoint.x, shifted.y - worldPoint.y);
}

// The nearest edge within `tolerance` (world units); a draft or open chain
// has no closing edge.
export function findEdgeNearPoint(point: PointXY, vertices: PointXY[], completionMode: CompletionMode, tolerance = 0.5): number | null {
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

function distanceToSegment(point: PointXY, start: PointXY, end: PointXY): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / len2));
  const projection = { x: start.x + t * dx, y: start.y + t * dy };
  return Math.hypot(point.x - projection.x, point.y - projection.y);
}

export function findBoundaryRayNearPoint(canvasManager: ViewportApi, point: PointXY): number | null {
  const { completionMode, polytope } = getState();
  if (completionMode !== "open" || !polytope?.boundaryRays?.length) {
    return null;
  }

  const bounds = getVisibleBounds(canvasManager);
  for (let index = 0; index < polytope.boundaryRays.length; index++) {
    const ray = polytope.boundaryRays[index]!;
    const clipped = clipRayToBoundingBox({ x: ray.start[0], y: ray.start[1] }, { x: ray.direction[0], y: ray.direction[1] }, bounds);
    if (!clipped) continue;
    const [start, end] = clipped;
    if (distanceToSegment(point, start, end) < 0.5) {
      return index;
    }
  }
  return null;
}

function getViewAnchor3D(state: State, point: PointXY): DragViewAnchor3D | undefined {
  return state.is3DMode || state.isTransitioning3D ? { x: point.x, y: point.y, z: 0 } : undefined;
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
      grabOffset: {
        x: startPoint.x - logicalCoords.x,
        y: startPoint.y - logicalCoords.y,
      },
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
      if (Math.hypot(end.x - start.x, end.y - start.y) > 1e-6) {
        return {
          kind: "constraint",
          operation: {
            kind: "closed-line",
            lineIndex: edgeIndex,
            lines: lineContext.map(([A, B, C]) => [A, B, C]),
          },
          start: logicalCoords,
          normal: { x: line[0], y: line[1] },
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
        normal: { x: line[0], y: line[1] },
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
      normal: { x: line[0], y: line[1] },
    };
  }

  return null;
}

export function solverStartNearLocalPoint(canvasManager: ViewportApi, state: State, localX: number, localY: number): PointXY | null {
  const startPoint = displayedSolverStartPoint(state);
  if (!startPoint) return null;
  // project at the marker's drawn height: in 3D the ring rides at the first
  // iterate's z (its baked total, points[2]), matching SolverStartLayer
  const { points, count, stride } = state.iteratePath;
  const zTotal = count > 0 && stride >= 3 ? points[2]! : undefined;
  const screen = canvasManager.toCanvasCoords(startPoint.x, startPoint.y, zTotal);
  return Math.hypot(localX - screen.x, localY - screen.y) <= SOLVER_START_HIT_RADIUS ? startPoint : null;
}

export function exceedsDragThreshold(state: State, clientX: number, clientY: number): boolean {
  const editorInteraction = state.editorInteraction;
  const dragStartPos = editorInteraction.kind === "pending-drag" ? editorInteraction.dragStartPos : null;
  if (!dragStartPos) return false;
  return Math.hypot(clientX - dragStartPos.x, clientY - dragStartPos.y) > DRAG_THRESHOLD_PX;
}
