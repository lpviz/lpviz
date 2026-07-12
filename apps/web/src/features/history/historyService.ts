import { getState, setState, type HistoryEntry, type State } from "@/features/core/store";

// The 3D fields are optional so an already-captured HistoryEntry (which
// carries them only in 3D mode) can be re-saved as a snapshot source.
type HistorySnapshotSource = Pick<State, "vertices" | "objectiveVector" | "completionMode"> & Partial<Pick<State, "problemMode" | "vertices3" | "objectiveVector3" | "editor3Phase">>;
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
    ...(state.problemMode === "3d" || (state.problemMode === undefined && state.vertices3 !== undefined)
      ? {
          vertices3: structuredClone(state.vertices3 ?? []),
          objectiveVector3: state.objectiveVector3 ? { ...state.objectiveVector3 } : null,
          editor3Phase: state.editor3Phase ?? "sketch",
        }
      : {}),
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
    if (sourceStack.length === 0) return;
    const stateToRestore = sourceStack[sourceStack.length - 1]!;
    const trimmed = sourceStack.slice(0, -1);
    const restored3D =
      stateToRestore.vertices3 !== undefined
        ? {
            vertices3: stateToRestore.vertices3,
            objectiveVector3: stateToRestore.objectiveVector3 ?? null,
            editor3Phase: stateToRestore.editor3Phase ?? "sketch",
          }
        : {};
    setState(
      isRedo
        ? {
            redoStack: trimmed,
            vertices: stateToRestore.vertices,
            objectiveVector: stateToRestore.objectiveVector,
            completionMode: stateToRestore.completionMode,
            ...restored3D,
          }
        : {
            historyStack: trimmed,
            redoStack: [...redoStack, currentEntry],
            vertices: stateToRestore.vertices,
            objectiveVector: stateToRestore.objectiveVector,
            completionMode: stateToRestore.completionMode,
            ...restored3D,
          },
    );
    onRestore();
  };
  return { save, handleUndoRedo };
}
