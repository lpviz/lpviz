import { getState, setState, type HistoryEntry, type State } from "@/features/core/store";

type HistorySnapshotSource = Pick<State, "vertices" | "objectiveVector" | "completionMode">;
export type SaveHistory = (snapshotSource?: HistorySnapshotSource, options?: { clearRedo?: boolean }) => void;
export type HandleUndoRedo = (isRedo: boolean) => void;
export type HistoryService = {
  save: SaveHistory;
  handleUndoRedo: HandleUndoRedo;
};

export function createHistoryService(onRestore: () => void): HistoryService {
  const captureEntry = (state: HistorySnapshotSource): HistoryEntry => ({
    vertices: structuredClone(state.vertices),
    objectiveVector: state.objectiveVector ? { ...state.objectiveVector } : null,
    completionMode: state.completionMode,
  });
  const save: SaveHistory = (snapshotSource = getState(), options = {}) => {
    const snapshot = captureEntry(snapshotSource);
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
    const currentEntry = captureEntry(getState());
    const { historyStack, redoStack } = getState();
    const sourceStack = isRedo ? redoStack : historyStack;
    const stateToRestore = sourceStack[sourceStack.length - 1]!;
    const trimmed = sourceStack.slice(0, -1);
    setState(
      isRedo
        ? {
            redoStack: trimmed,
            vertices: stateToRestore.vertices,
            objectiveVector: stateToRestore.objectiveVector,
            completionMode: stateToRestore.completionMode,
          }
        : {
            historyStack: trimmed,
            redoStack: [...redoStack, currentEntry],
            vertices: stateToRestore.vertices,
            objectiveVector: stateToRestore.objectiveVector,
            completionMode: stateToRestore.completionMode,
          },
    );
    onRestore();
  };
  return { save, handleUndoRedo };
}
