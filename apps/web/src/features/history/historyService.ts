import { getState, setState } from "@/features/core/store";
import { captureHistoryEntry, type HistoryEntry } from "@/features/history/historyState";

export type HistoryService = {
  /** push an undo entry (the current drawing unless given one) and drop the redo stack */
  save: (snapshotSource?: HistoryEntry) => void;
  handleUndoRedo: (isRedo: boolean) => void;
};

export function createHistoryService(onRestore: () => void): HistoryService {
  const save = (snapshotSource: HistoryEntry = getState()) => {
    setState({ historyStack: [...getState().historyStack, captureHistoryEntry(snapshotSource)], redoStack: [] });
  };
  const handleUndoRedo = (isRedo: boolean) => {
    const current = getState();
    const sourceStack = isRedo ? current.redoStack : current.historyStack;
    const restored = sourceStack[sourceStack.length - 1];
    if (!restored) return;
    const trimmed = sourceStack.slice(0, -1);
    // the drawing being left goes onto the other stack
    const leaving = captureHistoryEntry(current);
    setState({
      ...(isRedo ? { historyStack: [...current.historyStack, leaving], redoStack: trimmed } : { historyStack: trimmed, redoStack: [...current.redoStack, leaving] }),
      vertices: restored.vertices,
      objectiveVector: restored.objectiveVector,
      completionMode: restored.completionMode,
    });
    onRestore();
  };
  return { save, handleUndoRedo };
}
