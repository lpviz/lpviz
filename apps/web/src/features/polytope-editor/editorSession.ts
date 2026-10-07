import type { CompletionMode, State } from "@/features/core/store";
import { computeDrawingPhase } from "@/features/core/store";
import { centroid, convexHull, isConvexChain, isConvexPolygon, polygonContains } from "@lpviz/math/geometry";
import type { Vec } from "@lpviz/math/types";
import { vecDistance } from "@lpviz/math/vec";
import { type PolytopeRepresentation } from "@lpviz/polytope/polytopeTypes";
import { deriveRegionFromPoints } from "@lpviz/polytope/regionAssembly";

type EditorRegionResult =
  | { status: "nonconvex" }
  | {
      status: "ready";
      polytope: PolytopeRepresentation;
      promotion: {
        vertices: Vec[];
        interiorPoint: Vec;
        completionMode: CompletionMode;
      } | null;
    };

type EditorEditResult = {
  vertices: Vec[];
  completionMode: CompletionMode;
  interiorPoint: Vec | null;
};

type EditorTransition =
  | { kind: "noop" }
  // the action that produced the rejection knows why; the reason travels with
  // the transition so callers don't each hardcode (and risk drifting) a message
  | { kind: "reject-nonconvex"; reason: string }
  | {
      kind: "edit";
      result: EditorEditResult;
    }
  | {
      kind: "select-objective";
      objectiveVector: Vec;
    };

export function getEditorContext(state: State) {
  const phase = computeDrawingPhase(state);
  const session =
    phase === "empty" || phase === "sketching_polytope"
      ? { kind: "drafting" as const }
      : phase === "awaiting_objective" || phase === "objective_preview"
        ? { kind: "selecting-objective" as const }
        : state.completionMode === "closed"
          ? { kind: "editing-closed" as const }
          : state.completionMode === "open"
            ? { kind: "editing-open" as const }
            : { kind: "drafting" as const };

  const isDraggingGeometry = state.editorInteraction.kind === "dragging" && state.editorInteraction.target.kind !== "objective";
  const geometry =
    session.kind === "editing-open"
      ? !isDraggingGeometry && state.polytope?.kind === "bounded" && state.polytope.vertices.length >= 3
        ? {
            vertices: state.polytope.vertices,
            mode: "closed" as const,
            isDerivedClosed: true,
          }
        : {
            vertices: state.vertices,
            mode: "open" as const,
            isDerivedClosed: false,
          }
      : session.kind === "editing-closed" || session.kind === "selecting-objective"
        ? {
            vertices: state.vertices,
            mode: "closed" as const,
            isDerivedClosed: false,
          }
        : {
            vertices: state.vertices,
            mode: "draft" as const,
            isDerivedClosed: false,
          };

  return {
    session,
    geometry,
    isDraggingGeometry,
  };
}

export function computeEditorRegionForState(state: State): EditorRegionResult {
  const { geometry, isDraggingGeometry } = getEditorContext(state);
  const sourceVertices = geometry.isDerivedClosed ? geometry.vertices : state.vertices;
  const sourceMode: CompletionMode = geometry.isDerivedClosed ? "closed" : state.completionMode;

  const isConvex = sourceMode === "open" ? isConvexChain(sourceVertices) : isConvexPolygon(sourceVertices);
  if (!isConvex) {
    return { status: "nonconvex" };
  }

  const region = deriveRegionFromPoints(sourceVertices, sourceMode === "open" ? "open" : "closed");

  if (geometry.isDerivedClosed) {
    return {
      status: "ready",
      polytope: region,
      promotion: {
        vertices: geometry.vertices,
        interiorPoint: centroid(geometry.vertices),
        completionMode: "closed",
      },
    };
  }

  const shouldPromoteOpenRegion = sourceMode === "open" && !isDraggingGeometry && region.kind === "bounded" && region.vertices.length >= 3;

  if (!shouldPromoteOpenRegion) {
    return {
      status: "ready",
      polytope: region,
      promotion: null,
    };
  }

  return {
    status: "ready",
    polytope: deriveRegionFromPoints(region.vertices, "closed"),
    promotion: {
      vertices: region.vertices,
      interiorPoint: centroid(region.vertices),
      completionMode: "closed",
    },
  };
}

// Every edit is its own undoable step (closing included; otherwise undo jumps
// back past the close AND the last-placed vertex).
const edit = (vertices: Vec[], completionMode: CompletionMode, interiorPoint: Vec | null): EditorTransition => ({
  kind: "edit",
  result: { vertices, completionMode, interiorPoint },
});

export function getEditorTransition(
  state: State,
  action:
    | { kind: "click"; point: Vec; closeThreshold?: number }
    | { kind: "finish-open" }
    | { kind: "delete-vertex"; deleteIndex: number }
    | { kind: "insert-edge-point"; edgeIndex: number; point: Vec }
    | { kind: "insert-boundary-ray-point"; rayIndex: number; point: Vec }
    | { kind: "repair-displayed-hull"; point: Vec },
): EditorTransition {
  const context = getEditorContext(state);
  switch (action.kind) {
    case "click": {
      if (context.session.kind === "selecting-objective") {
        return {
          kind: "select-objective",
          objectiveVector: state.currentObjective || action.point,
        };
      }

      if (context.session.kind !== "drafting") {
        return { kind: "noop" };
      }

      if (state.vertices.length >= 3) {
        // closeThreshold is supplied by the canvas caller as the world-space
        // equivalent of a fixed pixel hit radius, so closing on the first
        // vertex stays equally easy at any zoom (it is otherwise a tiny target
        // when zoomed out, e.g. on mobile). Defaults to a world distance.
        const closeThreshold = action.closeThreshold ?? 0.5;
        if (vecDistance(action.point, state.vertices[0]!) < closeThreshold) {
          return edit(state.vertices, "closed", centroid(state.vertices));
        }

        if (polygonContains(state.vertices, action.point)) {
          return edit(state.vertices, "closed", action.point);
        }
      }

      const tentative = [...state.vertices, action.point];
      if (tentative.length >= 3 && !isConvexPolygon(tentative)) {
        return {
          kind: "reject-nonconvex",
          reason: "Adding this vertex would make the polytope nonconvex. Please choose another point.",
        };
      }

      return edit(tentative, "draft", null);
    }
    case "finish-open":
      if (context.session.kind !== "drafting" || state.vertices.length < 2) {
        return { kind: "noop" };
      }

      if (!isConvexChain(state.vertices)) {
        return {
          kind: "reject-nonconvex",
          reason: "This open region is nonconvex. Please adjust the vertices before pressing Enter.",
        };
      }

      return edit(state.vertices, "open", null);
    case "delete-vertex": {
      const {
        session,
        geometry: { vertices: displayVertices, isDerivedClosed },
      } = context;
      const nextVertices = displayVertices.filter((_, index) => index !== action.deleteIndex);
      const closed = isDerivedClosed || state.completionMode === "closed";

      // The polygon stays closed, minus the vertex: dropping a vertex of a
      // convex polygon keeps it convex, so there is nothing to reject. A
      // triangle has nothing left to close and goes back to drafting.
      if (closed && nextVertices.length >= 3) {
        return edit(nextVertices, "closed", centroid(nextVertices));
      }

      return edit(nextVertices, closed || session.kind === "drafting" || nextVertices.length < 2 ? "draft" : "open", null);
    }
    case "insert-edge-point": {
      const {
        geometry: { vertices: displayVertices, isDerivedClosed },
      } = context;
      const start = displayVertices[action.edgeIndex];
      const end = displayVertices[action.edgeIndex + 1] ?? displayVertices[0];
      if (!start || !end) {
        return { kind: "noop" };
      }

      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) {
        return { kind: "noop" };
      }

      const t = Math.max(0, Math.min(1, ((action.point[0] - start[0]) * dx + (action.point[1] - start[1]) * dy) / len2));
      const nextVertices = displayVertices.slice();
      nextVertices.splice(action.edgeIndex + 1, 0, [start[0] + t * dx, start[1] + t * dy]);

      return isDerivedClosed ? edit(nextVertices, "closed", centroid(nextVertices)) : edit(nextVertices, state.completionMode, state.interiorPoint);
    }
    case "insert-boundary-ray-point": {
      if (context.session.kind !== "editing-open") {
        return { kind: "noop" };
      }

      const nextVertices = state.vertices.slice();
      if (action.rayIndex === 0) {
        nextVertices.unshift(action.point);
      } else {
        nextVertices.push(action.point);
      }

      return edit(nextVertices, "open", null);
    }
    case "repair-displayed-hull": {
      const {
        geometry: { vertices: displayVertices, mode },
      } = context;
      if (mode !== "closed" || displayVertices.length < 3) {
        return { kind: "noop" };
      }

      if (isConvexPolygon(displayVertices) || !polygonContains(displayVertices, action.point)) {
        return { kind: "noop" };
      }

      const hull = convexHull(displayVertices);
      if (hull.length < 3) {
        return { kind: "noop" };
      }

      return edit(hull, "closed", centroid(hull));
    }
  }
}
