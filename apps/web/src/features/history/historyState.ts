import type { CompletionMode } from "@/features/polytope-editor/editorState";
import type { PointXY } from "@lpviz/math/types";

export type HistoryEntry = {
  vertices: PointXY[];
  objectiveVector: PointXY | null;
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
