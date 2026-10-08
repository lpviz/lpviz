import type { CompletionMode } from "@/features/polytope-editor/editorState";
import type { Vec } from "@lpviz/math/types";

export type HistoryEntry = {
  vertices: Vec[];
  objectiveVector: Vec | null;
  completionMode: CompletionMode;
};

// The undo/redo slice of the store. Its fields repaint nothing, so it has no dirty table.
export type HistoryState = {
  historyStack: HistoryEntry[];
  redoStack: HistoryEntry[];
};

export function freshHistoryState(): HistoryState {
  return {
    historyStack: [],
    redoStack: [],
  };
}

/** What undo restores, copied so later edits cannot reach into the entry. */
export function captureHistoryEntry(state: HistoryEntry): HistoryEntry {
  return {
    vertices: state.vertices.map((vertex) => [...vertex]),
    objectiveVector: state.objectiveVector ? [...state.objectiveVector] : null,
    completionMode: state.completionMode,
  };
}
