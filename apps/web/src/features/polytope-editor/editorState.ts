import type { ViewportState } from "@/features/viewport/viewportState";
import type { Constraint, Vec } from "@lpviz/math/types";
import { vecDistance, type Dimension } from "@lpviz/math/vec";
import { hasConstraints, type Polytope } from "@lpviz/polytope/polytope";
import type { ViewportDirtyFlags } from "@lpviz/viewport/types";

export const COMPLETION_MODES = ["draft", "closed", "open"] as const;
export type CompletionMode = (typeof COMPLETION_MODES)[number];
type CompletedInteraction = "none" | "dragged-point" | "dragged-objective" | "dragged-constraint" | "dragged-start";
export type DrawingPhase = "empty" | "sketching_polytope" | "awaiting_objective" | "objective_preview" | "ready_for_solvers";
type ConstraintDragOperation = { kind: "closed-line"; lineIndex: number; constraints: Constraint[] } | { kind: "open-vertices"; vertexIndices: [number, number] };
export type DragViewAnchor3D = { x: number; y: number; z: number };

export type DragTarget =
  | { kind: "point"; index: number; viewAnchor3D?: DragViewAnchor3D | undefined }
  | {
      kind: "constraint";
      operation: ConstraintDragOperation;
      start: Vec;
      normal: Vec;
    }
  | { kind: "objective"; viewAnchor3D?: DragViewAnchor3D | undefined }
  | {
      kind: "solver-start";
      // marker minus pointer-ray point at grab time: the ring can render lifted off the z = 0 drag
      // plane in 3D, so dragging moves the marker relative to the ray point instead of teleporting it
      grabOffset?: Vec;
      viewAnchor3D?: DragViewAnchor3D | undefined;
    };
export type EditorInteractionState =
  | { kind: "idle" }
  | {
      kind: "pending-drag";
      target: Extract<DragTarget, { kind: "point" | "constraint" }>;
      dragStartPos: { x: number; y: number };
    }
  | { kind: "dragging"; target: DragTarget };

// The polytope editor's slice of the store: the drawn region, the objective and the pointer interaction.
export type EditorState = {
  dimension: Dimension;
  vertices: Vec[];
  completionMode: CompletionMode;
  interiorPoint: Vec | null;
  polytope: Polytope | null;
  inequalitiesMessage: string | null;

  objectiveVector: Vec | null;
  currentObjective: Vec | null;
  objectiveHidden: boolean;

  snapToGrid: boolean;
  highlightIndex: number | null;
  editorInteraction: EditorInteractionState;
  lastCompletedInteraction: CompletedInteraction;
};

// The field a reset leaves alone: the dimension is fixed for the session when the app boots.
export type EditorRuntimeState = Pick<EditorState, "dimension">;

export function freshEditorState(): Omit<EditorState, keyof EditorRuntimeState> {
  return {
    vertices: [],
    completionMode: "draft",
    interiorPoint: null,
    polytope: null,
    inequalitiesMessage: null,

    objectiveVector: null,
    currentObjective: null,
    objectiveHidden: false,

    snapToGrid: false,
    highlightIndex: null,
    editorInteraction: { kind: "idle" },
    lastCompletedInteraction: "none",
  };
}

export function initialEditorRuntimeState(): EditorRuntimeState {
  return { dimension: 2 };
}

const POLYTOPE_DIRTY: ViewportDirtyFlags = {
  polytope: true,
  constraints: true,
  objective: true,
};
// the objective marker is occluded by the polytope floor in 3D, so a moved
// objective repaints the polytope too while in (or transitioning to) 3D
const objectiveDirty = (s: Pick<ViewportState, "is3DMode" | "isTransitioning3D">): ViewportDirtyFlags =>
  s.is3DMode || s.isTransitioning3D ? { polytope: true, objective: true } : { objective: true };

// Which render layers a change to each editor field repaints (merged into the store's FIELD_DIRTY).
export const EDITOR_DIRTY: Partial<Record<keyof EditorState, (s: Pick<ViewportState, "is3DMode" | "isTransitioning3D">) => ViewportDirtyFlags>> = {
  vertices: () => POLYTOPE_DIRTY,
  polytope: () => POLYTOPE_DIRTY,
  completionMode: () => POLYTOPE_DIRTY,
  interiorPoint: () => POLYTOPE_DIRTY,
  objectiveVector: objectiveDirty,
  currentObjective: objectiveDirty,
  objectiveHidden: () => ({ objective: true }),
  highlightIndex: () => ({ constraints: true }),
};

export function computeDrawingPhase(state: EditorState): DrawingPhase {
  const verticesCount = state.vertices.length;
  const regionFinished = state.completionMode !== "draft";
  const hasObjective = state.objectiveVector !== null;

  if (verticesCount === 0) {
    return "empty";
  }
  if (!regionFinished) {
    return "sketching_polytope";
  }
  if (!hasObjective) {
    return state.currentObjective !== null ? "objective_preview" : "awaiting_objective";
  }
  return "ready_for_solvers";
}

/** Nearest vertex of the feasible region, or null if there are none. */
export function nearestPolytopeVertex(state: EditorState, point: Vec): Vec | null {
  if (!hasConstraints(state.polytope)) return null;
  let best: Vec | null = null;
  let bestDistance = Infinity;
  for (const vertex of state.polytope.vertices) {
    const distance = vecDistance(vertex, point);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [...vertex];
    }
  }
  return best;
}
