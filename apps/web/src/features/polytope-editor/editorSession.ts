import type { CompletionMode, State } from "@/features/core/store";
import { computeDrawingPhase } from "@/features/core/store";
import {
  centroid,
  isConvexChain,
  isConvexPolygon,
  signedArea,
  VRep,
} from "@lpviz/math/geometry";
import type { PointXY } from "@lpviz/math/types";
import { type PolytopeRepresentation } from "@lpviz/polytope/polytopeTypes";
import { deriveRegionFromPoints } from "@lpviz/polytope/regionAssembly";

type EditorRegionResult =
  | { status: "nonconvex" }
  | {
      status: "ready";
      polytope: PolytopeRepresentation;
      promotion: {
        vertices: PointXY[];
        interiorPoint: PointXY;
        completionMode: CompletionMode;
      } | null;
    };

type EditorEditResult = {
  vertices: PointXY[];
  completionMode: CompletionMode;
  interiorPoint: PointXY | null;
};

type EditorTransition =
  | { kind: "noop" }
  // the action that produced the rejection knows why; the reason travels with
  // the transition so callers don't each hardcode (and risk drifting) a message
  | { kind: "reject-nonconvex"; reason: string }
  | {
      kind: "edit";
      result: EditorEditResult;
      saveToHistory: boolean;
    }
  | {
      kind: "select-objective";
      objectiveVector: PointXY;
      saveToHistory: boolean;
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

  const isDraggingGeometry =
    state.editorInteraction.kind === "dragging" &&
    state.editorInteraction.target.kind !== "objective";
  const geometry =
    session.kind === "editing-open"
      ? !isDraggingGeometry &&
        state.polytope?.kind === "bounded" &&
        state.polytope.vertices.length >= 3
        ? {
            vertices: state.polytope.vertices.map(([x, y]) => ({ x, y })),
            mode: "closed" as const,
            isDerivedClosed: true,
          }
        : {
            vertices: state.vertices,
            mode: "open" as const,
            isDerivedClosed: false,
          }
      : session.kind === "editing-closed" ||
          session.kind === "selecting-objective"
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
  const sourceVertices = geometry.isDerivedClosed
    ? geometry.vertices
    : state.vertices;
  const sourceMode: CompletionMode = geometry.isDerivedClosed
    ? "closed"
    : state.completionMode;

  const isConvex =
    sourceMode === "open"
      ? isConvexChain(sourceVertices)
      : isConvexPolygon(sourceVertices);
  if (!isConvex) {
    return { status: "nonconvex" };
  }

  const vertexRep = VRep.fromPoints(sourceVertices);
  const region =
    sourceMode === "draft"
      ? deriveRegionFromPoints(vertexRep.toVertices(), "closed")
      : deriveRegionFromPoints(
          sourceVertices.map(
            (vertex) => [vertex.x, vertex.y] as [number, number],
          ),
          sourceMode,
        );

  if (geometry.isDerivedClosed) {
    return {
      status: "ready",
      polytope: region,
      promotion: {
        vertices: geometry.vertices,
        interiorPoint: VRep.fromPoints(geometry.vertices).centroidPoint(),
        completionMode: "closed",
      },
    };
  }

  const shouldPromoteOpenRegion =
    sourceMode === "open" &&
    !isDraggingGeometry &&
    region.kind === "bounded" &&
    region.vertices.length >= 3;

  if (!shouldPromoteOpenRegion) {
    return {
      status: "ready",
      polytope: region,
      promotion: null,
    };
  }

  const promotedVertices = region.vertices.map(([x, y]) => ({ x, y }));
  const [cx, cy] = centroid(region.vertices);
  return {
    status: "ready",
    polytope: deriveRegionFromPoints(
      promotedVertices.map(({ x, y }) => [x, y] as [number, number]),
      "closed",
    ),
    promotion: {
      vertices: promotedVertices,
      interiorPoint: { x: cx, y: cy },
      completionMode: "closed",
    },
  };
}

export function getEditorTransition(
  state: State,
  action:
    | { kind: "click"; point: PointXY; closeThreshold?: number }
    | { kind: "finish-open" }
    | { kind: "delete-vertex"; deleteIndex: number }
    | { kind: "insert-edge-point"; edgeIndex: number; point: PointXY }
    | { kind: "insert-boundary-ray-point"; rayIndex: number; point: PointXY }
    | { kind: "repair-displayed-hull"; point: PointXY },
): EditorTransition {
  const context = getEditorContext(state);
  switch (action.kind) {
    case "click": {
      if (context.session.kind === "selecting-objective") {
        return {
          kind: "select-objective",
          objectiveVector: state.currentObjective || action.point,
          saveToHistory: true,
        };
      }

      if (context.session.kind !== "drafting") {
        return { kind: "noop" };
      }

      if (state.vertices.length >= 3) {
        const polytope = VRep.fromPoints(state.vertices);
        // closeThreshold is supplied by the canvas caller as the world-space
        // equivalent of a fixed pixel hit radius, so closing on the first
        // vertex stays equally easy at any zoom (it is otherwise a tiny target
        // when zoomed out, e.g. on mobile). Defaults to a world distance.
        const closeThreshold = action.closeThreshold ?? 0.5;
        if (VRep.distance(action.point, state.vertices[0]) < closeThreshold) {
          return {
            kind: "edit",
            result: {
              vertices: state.vertices,
              completionMode: "closed",
              interiorPoint: polytope.centroidPoint(),
            },
            // closing is its own undoable step, like finish-open; otherwise
            // undo jumps back past the close AND the last-placed vertex
            saveToHistory: true,
          };
        }

        if (polytope.contains(action.point)) {
          return {
            kind: "edit",
            result: {
              vertices: state.vertices,
              completionMode: "closed",
              interiorPoint: { x: action.point.x, y: action.point.y },
            },
            saveToHistory: true,
          };
        }
      }

      const tentative = [...state.vertices, action.point];
      if (tentative.length >= 3 && !VRep.fromPoints(tentative).isConvex()) {
        return {
          kind: "reject-nonconvex",
          reason:
            "Adding this vertex would make the polytope nonconvex. Please choose another point.",
        };
      }

      return {
        kind: "edit",
        result: {
          vertices: tentative,
          completionMode: "draft",
          interiorPoint: null,
        },
        saveToHistory: true,
      };
    }
    case "finish-open":
      if (context.session.kind !== "drafting" || state.vertices.length < 2) {
        return { kind: "noop" };
      }

      if (!isConvexChain(state.vertices)) {
        return {
          kind: "reject-nonconvex",
          reason:
            "This open region is nonconvex. Please adjust the vertices before pressing Enter.",
        };
      }

      return {
        kind: "edit",
        result: {
          vertices: state.vertices,
          completionMode: "open",
          interiorPoint: null,
        },
        saveToHistory: true,
      };
    case "delete-vertex": {
      const {
        session,
        geometry: { vertices: displayVertices, isDerivedClosed },
      } = context;
      const nextVertices = displayVertices.filter(
        (_, index) => index !== action.deleteIndex,
      );

      if (isDerivedClosed || session.kind === "editing-closed") {
        if (nextVertices.length < 2) {
          return {
            kind: "edit",
            result: {
              vertices: nextVertices,
              completionMode: "draft",
              interiorPoint: null,
            },
            saveToHistory: true,
          };
        }

        const reopenedVertices = Array.from(
          { length: nextVertices.length },
          (_, offset) => {
            const sourceIndex =
              (action.deleteIndex + 1 + offset) % displayVertices.length;
            return displayVertices[sourceIndex];
          },
        );
        const orientedVertices =
          signedArea(displayVertices) > 0
            ? reopenedVertices.reverse()
            : reopenedVertices;

        return {
          kind: "edit",
          result: {
            vertices: orientedVertices,
            completionMode: "open",
            interiorPoint: null,
          },
          saveToHistory: true,
        };
      }

      if (session.kind === "drafting") {
        return {
          kind: "edit",
          result: {
            vertices: nextVertices,
            completionMode: "draft",
            interiorPoint: null,
          },
          saveToHistory: true,
        };
      }

      return {
        kind: "edit",
        result: {
          vertices: nextVertices,
          completionMode: nextVertices.length >= 2 ? "open" : "draft",
          interiorPoint: null,
        },
        saveToHistory: true,
      };
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

      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) {
        return { kind: "noop" };
      }

      const t = Math.max(
        0,
        Math.min(
          1,
          ((action.point.x - start.x) * dx + (action.point.y - start.y) * dy) /
            len2,
        ),
      );
      const nextVertices = displayVertices.slice();
      nextVertices.splice(action.edgeIndex + 1, 0, {
        x: start.x + t * dx,
        y: start.y + t * dy,
      });

      if (isDerivedClosed) {
        return {
          kind: "edit",
          result: {
            vertices: nextVertices,
            completionMode: "closed",
            interiorPoint: VRep.fromPoints(nextVertices).centroidPoint(),
          },
          saveToHistory: true,
        };
      }

      return {
        kind: "edit",
        result: {
          vertices: nextVertices,
          completionMode: state.completionMode,
          interiorPoint: state.interiorPoint,
        },
        saveToHistory: true,
      };
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

      return {
        kind: "edit",
        result: {
          vertices: nextVertices,
          completionMode: "open",
          interiorPoint: null,
        },
        saveToHistory: true,
      };
    }
    case "repair-displayed-hull": {
      const {
        geometry: { vertices: displayVertices, mode },
      } = context;
      if (mode !== "closed" || displayVertices.length < 3) {
        return { kind: "noop" };
      }

      const polytope = VRep.fromPoints(displayVertices);
      if (polytope.isConvex() || !polytope.contains(action.point)) {
        return { kind: "noop" };
      }

      const hull = polytope.computeConvexHull();
      if (hull.length < 3) {
        return { kind: "noop" };
      }

      return {
        kind: "edit",
        result: {
          vertices: hull,
          completionMode: "closed",
          interiorPoint: VRep.fromPoints(hull).centroidPoint(),
        },
        saveToHistory: true,
      };
    }
  }
}
