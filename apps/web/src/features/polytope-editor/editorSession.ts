// The editor's model of the drawing: the session (what the editor is doing), the geometry it shows
// (the drawn chain, or the closure derived for an open region that closed up), the region derived
// from it, and the transition each edit makes.

import type { State } from "@/features/core/store";
import { type CompletionMode } from "@/features/polytope-editor/editorState";
import { computeDrawingPhase, derivedClosure } from "@/features/problem/selectors";
import { centroid, convexHull, isConvexChain, isConvexPolygon, polygonContains, segmentProjection } from "@lpviz/math/polygon";
import type { Vec } from "@lpviz/math/types";
import { vecDistance } from "@lpviz/math/vec";
import { derivePolytope, type Polytope } from "@lpviz/polytope/polytope";

type EditorRegionResult =
  | { status: "nonconvex" }
  | {
      status: "ready";
      polytope: Polytope;
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

export type EditorTransition =
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

type EditorSession = "drafting" | "selecting-objective" | "editing-closed" | "editing-open";

// What the drawing shows for a session: a drafted chain, an open region's chain, or a polygon (a
// closed region, and an open one while its objective is placed).
const displayedMode = (session: EditorSession): CompletionMode => (session === "editing-open" ? "open" : session === "drafting" ? "draft" : "closed");

// What the editor is doing with the drawing: sketching it, placing its objective, or editing a
// finished region (whose kind decides which edits apply).
function sessionOf(state: State): EditorSession {
  switch (computeDrawingPhase(state)) {
    case "empty":
    case "sketching_polytope":
      return "drafting";
    case "awaiting_objective":
    case "objective_preview":
      return "selecting-objective";
    case "ready_for_solvers":
      return state.completionMode === "open" ? "editing-open" : "editing-closed";
  }
}

// a finished region on these vertices, with its interior point at their centroid
const closedOn = (vertices: Vec[]) => ({ vertices, interiorPoint: centroid(vertices), completionMode: "closed" as const });

export function getEditorContext(state: State) {
  const session = sessionOf(state);
  const isDraggingGeometry = state.editorInteraction.kind === "dragging" && state.editorInteraction.target.kind !== "objective";
  // while its geometry is dragged an open chain is edited as drawn, not as the hull it closed into
  const derived = session === "editing-open" && !isDraggingGeometry ? derivedClosure(state) : null;
  const geometry = derived ? { vertices: derived, mode: "closed" as const, isDerivedClosed: true } : { vertices: state.vertices, mode: displayedMode(session), isDerivedClosed: false };

  return {
    session,
    geometry,
    isDraggingGeometry,
  };
}

export function computeEditorRegionForState(state: State): EditorRegionResult {
  const { geometry, isDraggingGeometry } = getEditorContext(state);
  // the region's own mode, not the displayed geometry's: an open region whose objective is being
  // placed is shown closed but is still validated as the chain it is
  const sourceMode: CompletionMode = geometry.isDerivedClosed ? "closed" : state.completionMode;

  const isConvex = sourceMode === "open" ? isConvexChain(geometry.vertices) : isConvexPolygon(geometry.vertices);
  if (!isConvex) return { status: "nonconvex" };

  // a draft is derived as if closed so the fill preview and the panel show the polygon so far
  const region = derivePolytope(geometry.vertices, sourceMode !== "open");

  if (geometry.isDerivedClosed) return { status: "ready", polytope: region, promotion: closedOn(geometry.vertices) };

  // an open chain whose region came out bounded is promoted to the polygon it closed into
  const promoteOpenRegion = sourceMode === "open" && !isDraggingGeometry && region.kind === "bounded" && region.vertices.length >= 3;
  if (!promoteOpenRegion) return { status: "ready", polytope: region, promotion: null };
  return { status: "ready", polytope: derivePolytope(region.vertices, true), promotion: closedOn(region.vertices) };
}

// Every edit is its own undoable step (closing included; otherwise undo jumps
// back past the close AND the last-placed vertex).
const edit = (vertices: Vec[], completionMode: CompletionMode, interiorPoint: Vec | null): EditorTransition => ({
  kind: "edit",
  result: { vertices, completionMode, interiorPoint },
});
const closeOn = (vertices: Vec[]): EditorTransition => ({ kind: "edit", result: closedOn(vertices) });

const NOOP: EditorTransition = { kind: "noop" };
const reject = (reason: string): EditorTransition => ({ kind: "reject-nonconvex", reason });

// A click: the objective while one is being selected; while drafting, the region closed on its
// first vertex, an interior point that closes it, or one more vertex when convexity allows. A
// click on any other vertex (the second click of a quick double click, most often) does nothing:
// a vertex stacked on another leaves a near-zero edge whose direction is noise, and the next
// click would be rejected as nonconvex. `closeThreshold` is the world-space equivalent of a fixed
// pixel hit radius, so closing on the first vertex stays equally easy at any zoom (it is
// otherwise a tiny target when zoomed out, e.g. on mobile).
export function clickAt(state: State, point: Vec, closeThreshold: number): EditorTransition {
  const { session } = getEditorContext(state);
  if (session === "selecting-objective") return { kind: "select-objective", objectiveVector: state.currentObjective || point };
  if (session !== "drafting") return NOOP;
  if (state.vertices.length >= 3 && vecDistance(point, state.vertices[0]!) < closeThreshold) return closeOn(state.vertices);
  if (state.vertices.some((vertex) => vecDistance(point, vertex) < closeThreshold)) return NOOP;
  if (state.vertices.length >= 3 && polygonContains(state.vertices, point)) return edit(state.vertices, "closed", point);
  const tentative = [...state.vertices, point];
  if (tentative.length >= 3 && !isConvexPolygon(tentative)) return reject("Adding this vertex would make the polytope nonconvex. Please choose another point.");
  return edit(tentative, "draft", null);
}

/** The drafted region left open, as Enter does. */
export function finishOpen(state: State): EditorTransition {
  if (getEditorContext(state).session !== "drafting" || state.vertices.length < 2) return NOOP;
  if (!isConvexChain(state.vertices)) return reject("This open region is nonconvex. Adjust the vertices before leaving it open.");
  return edit(state.vertices, "open", null);
}

// The polygon stays closed, minus the vertex: dropping a vertex of a convex polygon keeps it
// convex, so there is nothing to reject. A triangle has nothing left to close and goes back to
// drafting.
export function deleteVertex(state: State, deleteIndex: number): EditorTransition {
  const { session, geometry } = getEditorContext(state);
  const nextVertices = geometry.vertices.filter((_, index) => index !== deleteIndex);
  const closed = geometry.isDerivedClosed || state.completionMode === "closed";
  if (closed && nextVertices.length >= 3) return closeOn(nextVertices);
  return edit(nextVertices, closed || session === "drafting" || nextVertices.length < 2 ? "draft" : "open", null);
}

/** A vertex inserted on edge `edgeIndex`, at the point's projection onto it. */
export function insertOnEdge(state: State, edgeIndex: number, point: Vec): EditorTransition {
  const { vertices: displayVertices, isDerivedClosed } = getEditorContext(state).geometry;
  const start = displayVertices[edgeIndex];
  const end = displayVertices[edgeIndex + 1] ?? displayVertices[0];
  if (!start || !end) return NOOP;
  const { dx, dy, len2, t: projected } = segmentProjection(point, start, end);
  if (len2 === 0) return NOOP;
  const t = Math.max(0, Math.min(1, projected));
  const nextVertices = displayVertices.slice();
  nextVertices.splice(edgeIndex + 1, 0, [start[0] + t * dx, start[1] + t * dy]);
  return isDerivedClosed ? closeOn(nextVertices) : edit(nextVertices, state.completionMode, state.interiorPoint);
}

/** A vertex added on one of an open region's boundary rays: before the first vertex or after the last. */
export function insertOnRay(state: State, rayIndex: number, point: Vec): EditorTransition {
  if (getEditorContext(state).session !== "editing-open") return NOOP;
  const nextVertices = state.vertices.slice();
  if (rayIndex === 0) nextVertices.unshift(point);
  else nextVertices.push(point);
  return edit(nextVertices, "open", null);
}

/** A nonconvex closed drawing replaced by its convex hull, from a double click inside it. */
export function repairHull(state: State, point: Vec): EditorTransition {
  const { vertices: displayVertices, mode } = getEditorContext(state).geometry;
  if (mode !== "closed" || displayVertices.length < 3) return NOOP;
  if (isConvexPolygon(displayVertices) || !polygonContains(displayVertices, point)) return NOOP;
  const hull = convexHull(displayVertices);
  return hull.length < 3 ? NOOP : closeOn(hull);
}
