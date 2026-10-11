// The store: one immutable state value, patched by setState, read by getState. Listeners register
// per field (`on`) and a patch notifies each listener once, after the whole patch is applied, however
// many of its keys changed; a listener that patches the store during that delivery is drained in the
// same round, so every listener sees a settled state. The render layers listen through
// onViewportDirty, which fires after the field listeners with what the patch repaints.

import { freshHistoryState, type HistoryState } from "@/features/history/historyState";
import { EDITOR_DIRTY, freshEditorState, initialEditorRuntimeState, type EditorRuntimeState, type EditorState } from "@/features/polytope-editor/editorState";
import { freshSolverState, initialSolverRuntimeState, SOLVER_DIRTY, type SolverRuntimeState, type SolverState } from "@/features/solver/solverState";
import { freshViewportState, initialViewportRuntimeState, VIEWPORT_DIRTY, type ViewportRuntimeState, type ViewportState } from "@/features/viewport/viewportState";
import type { ViewportDirtyFlags, FieldDirty } from "@/features/viewport/repaint";

export type State = EditorState & SolverState & HistoryState & ViewportState;

// Which render layers a change to each store field repaints: the slices' tables merged. setState
// derives the repaint from the changed fields; fields absent here (pure UI/solver-config state,
// history) repaint nothing.
const FIELD_DIRTY: Partial<Record<keyof State, FieldDirty<State>>> = {
  ...EDITOR_DIRTY,
  ...SOLVER_DIRTY,
  ...VIEWPORT_DIRTY,
};

export function deriveViewportDirty(state: State, changedKeys: readonly (keyof State)[]): ViewportDirtyFlags | null {
  let flags: ViewportDirtyFlags | null = null;
  for (const key of changedKeys) {
    const dirty = FIELD_DIRTY[key];
    if (!dirty) continue;
    // build a fresh object (never mutate the shared flag constants)
    flags = Object.assign(flags ?? {}, typeof dirty === "function" ? dirty(state) : dirty);
  }
  return flags;
}

// The fields a reset leaves alone; each slice names its own (see the *RuntimeState types).
type RuntimeState = EditorRuntimeState & ViewportRuntimeState & SolverRuntimeState;

type FreshState = Omit<State, keyof RuntimeState>;

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

type DirtyListener = (flags: ViewportDirtyFlags) => void;

let values: State = initialState;
const listeners = new Map<keyof State, Listener[]>();
const dirtyListeners: DirtyListener[] = [];
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

export function setState(partial: Partial<State>): void {
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

  if (!nextValues) return;
  values = nextValues;
  for (const key of changedKeys) {
    const ls = listeners.get(key);
    if (!ls) continue;
    for (let i = 0; i < ls.length; i++) ls[i]!();
  }
  flush();

  // what the changed fields repaint (see FIELD_DIRTY), after every field listener has run
  const dirty = deriveViewportDirty(values, changedKeys);
  if (dirty === null) return;
  const batch = dirtyListeners.slice();
  for (let i = 0; i < batch.length; i++) batch[i]!(dirty);
}

export function on<K extends keyof State>(keys: readonly K[], fn: (values: Pick<State, K>) => void, signal: AbortSignal): void {
  if (signal.aborted) return;

  let scheduled = false;
  const run = () => {
    scheduled = false;
    const snap = {} as Pick<State, K>;
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

/** The render layers a patch repaints, as derived from the fields it changed. */
export function onViewportDirty(fn: DirtyListener, signal: AbortSignal): void {
  if (signal.aborted) return;
  dirtyListeners.push(fn);
  signal.addEventListener(
    "abort",
    () => {
      const index = dirtyListeners.indexOf(fn);
      if (index >= 0) dirtyListeners.splice(index, 1);
    },
    { once: true },
  );
}
