import { getState, setState, type HistoryEntry } from "@/features/core/store";
import { captureHistoryEntry } from "@/features/history/historyState";

export type SaveHistory = (snapshotSource?: HistoryEntry, options?: { clearRedo?: boolean }) => void;
export type HandleUndoRedo = (isRedo: boolean) => void;
export type HistoryService = {
  save: SaveHistory;
  handleUndoRedo: HandleUndoRedo;
};

export function createHistoryService(onRestore: () => void): HistoryService {
  const save: SaveHistory = (snapshotSource = getState(), options = {}) => {
    const snapshot = captureHistoryEntry(snapshotSource);
    const { historyStack } = getState();
    setState({
      historyStack: [...historyStack, snapshot],
      ...((options.clearRedo ?? true) ? { redoStack: [] } : {}),
    });
  };
  const handleUndoRedo: HandleUndoRedo = (isRedo) => {
    const state = getState();
    if (isRedo ? state.redoStack.length === 0 : state.historyStack.length === 0) return;
    if (isRedo) save(getState(), { clearRedo: false });
    const currentEntry = captureHistoryEntry(getState());
    const { historyStack, redoStack } = getState();
    const sourceStack = isRedo ? redoStack : historyStack;
    const stateToRestore = sourceStack[sourceStack.length - 1]!;
    const trimmed = sourceStack.slice(0, -1);
    setState({
      ...(isRedo ? { redoStack: trimmed } : { historyStack: trimmed, redoStack: [...redoStack, currentEntry] }),
      vertices: stateToRestore.vertices,
      objectiveVector: stateToRestore.objectiveVector,
      completionMode: stateToRestore.completionMode,
    });
    onRestore();
  };
  return { save, handleUndoRedo };
}
