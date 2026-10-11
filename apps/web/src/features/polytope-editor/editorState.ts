import { showsDepth, type ViewportState } from "@/features/viewport/viewportState";
import type { Constraint, PointXYZ, Vec } from "@lpviz/math/types";
import type { Dimension } from "@lpviz/math/vec";
import type { Polytope } from "@lpviz/polytope/polytope";
import type { ViewportDirtyFlags, FieldDirty } from "@/features/viewport/repaint";

export const COMPLETION_MODES = ["draft", "closed", "open"] as const;
export type CompletionMode = (typeof COMPLETION_MODES)[number];
type ConstraintDragOperation = { kind: "closed-line"; lineIndex: number; constraints: Constraint[] } | { kind: "open-vertices"; vertexIndices: [number, number] };

// What a drag holds, each with its 3D anchor: the grabbed point, whose view-aligned plane catches
// the pointer rays that miss the floor (see toLogicalCoords3D).
export type DragTarget = (
  | { kind: "point"; index: number }
  | { kind: "constraint"; operation: ConstraintDragOperation; start: Vec; normal: Vec }
  | { kind: "objective" }
  | {
      kind: "solver-start";
      // marker minus pointer-ray point at grab time: the ring can render lifted off the z = 0 drag
      // plane in 3D, so dragging moves the marker relative to the ray point instead of teleporting it
      grabOffset?: Vec;
    }
) & { viewAnchor3D?: PointXYZ | undefined };
type EditorInteractionState = { kind: "idle" } | { kind: "pending-drag"; target: DragTarget; dragStartPos: { x: number; y: number } } | { kind: "dragging"; target: DragTarget };

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
const objectiveDirty = (s: Pick<ViewportState, "is3DMode" | "isTransitioning3D">): ViewportDirtyFlags => (showsDepth(s) ? { polytope: true, objective: true } : { objective: true });

// Which render layers a change to each editor field repaints (merged into the store's FIELD_DIRTY).
export const EDITOR_DIRTY: Partial<Record<keyof EditorState, FieldDirty<Pick<ViewportState, "is3DMode" | "isTransitioning3D">>>> = {
  vertices: POLYTOPE_DIRTY,
  polytope: POLYTOPE_DIRTY,
  completionMode: POLYTOPE_DIRTY,
  objectiveVector: objectiveDirty,
  currentObjective: objectiveDirty,
  objectiveHidden: { objective: true },
  highlightIndex: { constraints: true },
};
