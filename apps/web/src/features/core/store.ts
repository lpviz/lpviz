import { freshHistoryState, type HistoryState } from "@/features/history/historyState";
import { EDITOR_DIRTY, freshEditorState, initialEditorRuntimeState, type EditorRuntimeState, type EditorState } from "@/features/polytope-editor/editorState";
import { freshSolverState, initialSolverRuntimeState, SOLVER_DIRTY, type SolverRuntimeState, type SolverState } from "@/features/solver/solverState";
import { freshViewportState, initialViewportRuntimeState, VIEWPORT_DIRTY, type ViewportRuntimeState, type ViewportState } from "@/features/viewport/viewportState";
import type { ViewportDirtyFlags } from "@/features/viewport/dirtyFlags";

// The slices' public surface, re-exported so importers keep one module to reach for.
export { DEFAULT_VIEW_ANGLE, DEFAULT_Z_SCALE } from "@lpviz/viewport/defaults";
export type { HistoryEntry } from "@/features/history/historyState";
export { COMPLETION_MODES, computeDrawingPhase, nearestPolytopeVertex, type CompletionMode, type DragTarget, type DrawingPhase } from "@/features/polytope-editor/editorState";
export {
  DEFAULT_SOLVER_SETTINGS,
  displayedSolverStartPoint,
  iterateHeight,
  MAX_TRACE_POINT_SPRITES,
  QUERY_POINTS,
  SOLVER_MODES,
  type EllipsoidPath,
  type EllipsoidQueryPoint,
  type IteratePath,
  type LocalizingSetPath,
  type SolverMode,
  type SolverSettings,
} from "@/features/solver/solverState";
export type { Dimension } from "@lpviz/math/vec";

type StateChangeMeta = {
  viewportDirty?: ViewportDirtyFlags;
};

export type State = EditorState & SolverState & HistoryState & ViewportState;

// Which render layers a change to each store field repaints: the slices' tables merged. setState
// derives `viewportDirty` from the changed fields; the derivation is additive (unioned with
// explicitly passed flags, it can only add, never drop) and fields absent here (pure UI/solver-config
// state, history) repaint nothing.
const FIELD_DIRTY: Partial<Record<keyof State, (s: State) => ViewportDirtyFlags>> = {
  ...EDITOR_DIRTY,
  ...SOLVER_DIRTY,
  ...VIEWPORT_DIRTY,
};

export function deriveViewportDirty(state: State, changedKeys: readonly (keyof State)[]): ViewportDirtyFlags | null {
  let flags: ViewportDirtyFlags | null = null;
  for (const key of changedKeys) {
    const derive = FIELD_DIRTY[key];
    if (!derive) continue;
    // build a fresh object (never mutate the shared flag constants)
    flags = Object.assign(flags ?? {}, derive(state));
  }
  return flags;
}

// The fields a reset leaves alone; each slice names its own (see the *RuntimeState types).
type RuntimeState = EditorRuntimeState & ViewportRuntimeState & SolverRuntimeState;

export type FreshState = Omit<State, keyof RuntimeState>;

/**
 * The starting values of everything else, composed from the slices. Fresh objects every call, so
 * a reset never shares an array or settings object with the state it replaces; the initial state
 * is built from it, so the two cannot drift apart. A reset applies it as one patch, and every
 * listener reads the whole patched state, so the order of the slices is immaterial.
 */
export function freshState(): FreshState {
  return { ...freshEditorState(), ...freshSolverState(), ...freshHistoryState(), ...freshViewportState() };
}

const initialState: State = {
  ...freshState(),
  ...initialEditorRuntimeState(),
  ...initialViewportRuntimeState(),
  ...initialSolverRuntimeState(),
};

type Listener = () => void;

type StateValues<K extends keyof State> = { [P in K]: State[P] };
type MetaListener = (meta?: StateChangeMeta) => void;

let values: State = initialState;
const listeners = new Map<keyof State, Listener[]>();
const metaListeners: MetaListener[] = [];
let pending: Listener[] = [];

export function getState(): Readonly<State> {
  return values;
}

function flush(): void {
  while (pending.length > 0) {
    const batch = pending;
    pending = [];
    for (let i = 0; i < batch.length; i++) batch[i]!();
  }
}

export function setState(partial: Partial<State>, meta?: StateChangeMeta): void {
  const changedKeys: (keyof State)[] = [];
  let nextValues: State | null = null;

  for (const rawKey in partial) {
    const key = rawKey as keyof State;
    const value = partial[key];
    if (Object.is(values[key], value)) continue;
    nextValues ??= { ...values };
    (nextValues as Record<keyof State, State[keyof State]>)[key] = value as State[keyof State];
    changedKeys.push(key);
  }

  if (nextValues) {
    values = nextValues;
    for (const key of changedKeys) {
      const ls = listeners.get(key);
      if (!ls) continue;
      for (let i = 0; i < ls.length; i++) ls[i]!();
    }
    flush();
  }

  // viewportDirty is the union of what the changed fields imply and anything
  // the caller passed explicitly (see FIELD_DIRTY)
  const derived = nextValues ? deriveViewportDirty(values, changedKeys) : null;
  if (meta === undefined && derived === null) return;
  let merged: StateChangeMeta = meta ?? {};
  if (derived !== null) {
    merged = {
      ...merged,
      viewportDirty: { ...merged.viewportDirty, ...derived },
    };
  }
  const metaBatch = metaListeners.slice();
  for (let i = 0; i < metaBatch.length; i++) metaBatch[i]!(merged);
}

export function on<K extends keyof State>(keys: readonly K[], fn: (values: StateValues<K>) => void, signal: AbortSignal): void {
  if (signal.aborted) return;

  let scheduled = false;
  const run = () => {
    scheduled = false;
    const snap = {} as StateValues<K>;
    for (const key of keys) snap[key] = values[key];
    fn(snap);
  };
  const handler = () => {
    if (scheduled) return;
    scheduled = true;
    pending.push(run);
  };

  for (const key of keys) {
    const ls = listeners.get(key);
    if (ls) ls.push(handler);
    else listeners.set(key, [handler]);
  }

  signal.addEventListener(
    "abort",
    () => {
      for (const key of keys) {
        const ls = listeners.get(key);
        if (!ls) continue;
        const index = ls.indexOf(handler);
        if (index >= 0) ls.splice(index, 1);
        if (ls.length === 0) listeners.delete(key);
      }
    },
    { once: true },
  );
}

export function onMeta(fn: MetaListener, signal: AbortSignal): void {
  if (signal.aborted) return;
  metaListeners.push(fn);
  signal.addEventListener(
    "abort",
    () => {
      const index = metaListeners.indexOf(fn);
      if (index >= 0) metaListeners.splice(index, 1);
    },
    { once: true },
  );
}
