import { DEFAULT_SOLVER_SETTINGS, type SolverMode, type SolverSettings } from "@/features/solver/solverSettings";
import { type EllipsoidPath, EMPTY_ITERATE_PATH, type IteratePath, type LocalizingSetPath, type ResultView } from "@/features/solver/types";
import type { Vec } from "@lpviz/math/types";
import type { ViewportDirtyFlags } from "@/features/viewport/dirtyFlags";

// The solver's slice of the store: the result panel, the solve and its iterates, and the trace.
export type SolverState = {
  result: ResultView;

  solverMode: SolverMode;
  solverSettings: SolverSettings;
  // Where IPM/PDHG/primal-simplex begin iterating; null = the solver default
  // (origin). Draggable via the canvas marker.
  solverStartPoint: Vec | null;
  iteratePath: IteratePath;
  iterateEllipsoids: EllipsoidPath | null;
  iterateLocalizingSets: LocalizingSetPath | null;
  iteratePhases: number[];
  highlightIteratePathIndex: number | null;
  rotateObjectiveMode: boolean;
  // "an Animate replay is playing out"; the RAF handle stays private to replayController, since a
  // store field that churned at 60Hz would invalidate every selector keyed on it
  replayActive: boolean;
  originalIteratePath: IteratePath;
  originalIteratePhases: number[];
  iterateRestartIndices: number[];

  traceEnabled: boolean;
  // the paths of earlier solves kept while tracing
  traceBuffer: IteratePath[];
  maxTraceCount: number;
};

// The field a reset leaves alone: the trace capacity mirrors the angle step (see setTraceCapacity).
export type SolverRuntimeState = Pick<SolverState, "maxTraceCount">;

export function freshSolverState(): Omit<SolverState, keyof SolverRuntimeState> {
  return {
    result: { kind: "usage" },

    solverMode: "central",
    solverSettings: { ...DEFAULT_SOLVER_SETTINGS },
    solverStartPoint: null,
    iteratePath: EMPTY_ITERATE_PATH,
    iterateEllipsoids: null,
    iterateLocalizingSets: null,
    iteratePhases: [],
    highlightIteratePathIndex: null,
    rotateObjectiveMode: false,
    replayActive: false,
    originalIteratePath: EMPTY_ITERATE_PATH,
    originalIteratePhases: [],
    iterateRestartIndices: [],

    traceEnabled: false,
    traceBuffer: [],
  };
}

export function initialSolverRuntimeState(): SolverRuntimeState {
  return {
    maxTraceCount: 0,
  };
}

const ITERATE_DIRTY: ViewportDirtyFlags = { iterate: true };
const TRACE_DIRTY: ViewportDirtyFlags = { trace: true };

// Which render layers a change to each solver field repaints (merged into the store's FIELD_DIRTY).
export const SOLVER_DIRTY: Partial<Record<keyof SolverState, ViewportDirtyFlags>> = {
  // the start marker renders in the iterate overlay pass
  solverStartPoint: ITERATE_DIRTY,
  solverMode: ITERATE_DIRTY,
  iteratePath: ITERATE_DIRTY,
  iterateEllipsoids: ITERATE_DIRTY,
  iterateLocalizingSets: ITERATE_DIRTY,
  iteratePhases: ITERATE_DIRTY,
  iterateRestartIndices: ITERATE_DIRTY,
  highlightIteratePathIndex: ITERATE_DIRTY,
  // the optimum star is hidden for the duration of a replay, so starting or
  // stopping one changes what the iterate pass draws (see createIterateStarLayer)
  replayActive: ITERATE_DIRTY,
  traceBuffer: TRACE_DIRTY,
  traceEnabled: TRACE_DIRTY,
};
