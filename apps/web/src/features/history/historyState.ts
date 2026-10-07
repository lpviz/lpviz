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
