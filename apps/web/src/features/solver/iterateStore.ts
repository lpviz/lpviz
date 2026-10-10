// The store writes that adopt, clear and trace a solve's iterate path.

import { getState, setState, type State } from "@/features/core/store";
import { EMPTY_ITERATE_PATH, type IteratePath } from "./solverState";
import type { SolverResultView } from "./types";

type IterateResult = Pick<SolverResultView, "iterations" | "phases" | "restartIndices" | "ellipsoids" | "localizingSets">;

// The flat path and phase/restart arrays are never mutated after creation
// (replay grows a fresh IteratePath over the same shared buffer), so the
// "original" fields can share them instead of deep-copying.
function iteratePatch({ iterations: path, phases, restartIndices, ellipsoids, localizingSets }: IterateResult): Partial<State> {
  return {
    originalIteratePath: path,
    iteratePath: path,
    // every solver but the ellipsoid family passes none, which clears the previous solve's shapes
    iterateEllipsoids: ellipsoids ?? null,
    iterateLocalizingSets: localizingSets ?? null,
    iteratePhases: phases ?? [],
    originalIteratePhases: phases ?? [],
    iterateRestartIndices: restartIndices ?? [],
  };
}

/** Adopt a solve's iterates as the current path, appending it to the trace when tracing. */
export function setIterateResult(result: IterateResult): void {
  const state = getState();
  const patch = iteratePatch(result);
  if (state.traceEnabled && result.iterations.count > 0) {
    patch.traceBuffer = appendedTraceBuffer(state, result.iterations);
  }
  setState(patch);
}

export function clearIterateState(): void {
  setState({ ...iteratePatch({ iterations: EMPTY_ITERATE_PATH }), highlightIteratePathIndex: null });
}

// the newest `capacity` entries of a trace buffer (the buffer itself when it fits)
const newest = (buffer: IteratePath[], capacity: number): IteratePath[] => (buffer.length > capacity ? buffer.slice(buffer.length - capacity) : buffer);

function appendedTraceBuffer(state: State, path: IteratePath): IteratePath[] {
  // The trace chunk shares the iterate path's flat buffers (no copy), which nothing mutates in
  // place; a replay interpolates over its own copy.
  return newest([...state.traceBuffer, { ...path }], state.maxTraceCount);
}

export function resetTraceState(): void {
  if (getState().traceBuffer.length === 0) return;
  setState({ traceBuffer: [] });
}

export function setTraceCapacity(maxTraceCount: number): void {
  const { traceBuffer } = getState();
  // a repaint is derived only when traceBuffer actually changes (eviction);
  // a capacity-only bump draws the same chunks
  setState({ maxTraceCount, traceBuffer: newest(traceBuffer, maxTraceCount) });
}
