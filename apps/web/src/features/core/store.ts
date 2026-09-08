import type { ResultTextBlock } from "@/features/solver/types";

// Result rows materialize (format) lazily on access so a 100k-iteration solve
// doesn't pay for formatting rows that are never scrolled into view. Plain
// arrays satisfy this shape, which keeps empty-state assignments simple.
type VirtualRowBlocks = {
  length: number;
  at(index: number): ResultTextBlock | undefined;
};
import type { Line, PointXY, PointXYZ } from "@lpviz/math/types";
import {
  hasPolytopeLines,
  type PolytopeRepresentation,
} from "@lpviz/polytope/polytopeTypes";
import type { EnteringRule, LeavingRule } from "@lpviz/solver-engine/simplex";
import { DEFAULT_VIEW_ANGLE, DEFAULT_Z_SCALE } from "@lpviz/viewport/defaults";

export const MAX_TRACE_POINT_SPRITES = 1200;
export { DEFAULT_VIEW_ANGLE, DEFAULT_Z_SCALE };

export type SolverMode = "central" | "ipm" | "simplex" | "pdhg";
export type CompletionMode = "draft" | "closed" | "open";
type CompletedInteraction =
  | "none"
  | "dragged-point"
  | "dragged-objective"
  | "dragged-constraint"
  | "dragged-start";
export type DrawingPhase =
  | "empty"
  | "sketching_polytope"
  | "awaiting_objective"
  | "objective_preview"
  | "ready_for_solvers";
type ConstraintDragOperation =
  | { kind: "closed-line"; lineIndex: number; lines: Line[] }
  | { kind: "open-vertices"; vertexIndices: [number, number] };
export type HistoryEntry = {
  vertices: PointXY[];
  objectiveVector: PointXY | null;
  completionMode: CompletionMode;
};
export type DragViewAnchor3D = { x: number; y: number; z: number };

export type DragTarget =
  | { kind: "point"; index: number; viewAnchor3D?: DragViewAnchor3D }
  | {
      kind: "constraint";
      operation: ConstraintDragOperation;
      start: PointXY;
      normal: PointXY;
    }
  | { kind: "objective"; viewAnchor3D?: DragViewAnchor3D }
  | {
      kind: "solver-start";
      // marker minus pointer-ray point at grab time: the ring can render
      // lifted off the z = 0 drag plane (it rides the path's convergence
      // lift in 3D), so dragging moves the marker relative to the ray
      // point instead of teleporting it there
      grabOffset?: PointXY;
      viewAnchor3D?: DragViewAnchor3D;
    };
export type EditorInteractionState =
  | { kind: "idle" }
  | {
      kind: "pending-drag";
      target: Extract<DragTarget, { kind: "point" | "constraint" }>;
      dragStartPos: { x: number; y: number };
    }
  | { kind: "dragging"; target: DragTarget };

// Flat, contiguous iterate data: element `i` lives at [i*stride .. i*stride+stride).
// stride 3 = [x, y, bakedTotalZ] (packed pdhg/ipm), stride 2 = [x, y] (simplex /
// central path, z renders flat). One array per solve instead of one Float64Array
// view per iterate keeps the iterate path and trace ring at a few dozen live
// objects rather than millions — which is what a (SpiderMonkey) major GC must
// mark, and was the source of the mid-rotation frame drops at high maxit.
export interface IteratePath {
  points: Float64Array;
  count: number;
  stride: number;
}

const EMPTY_ITERATE_PATH: IteratePath = {
  points: new Float64Array(0),
  count: 0,
  stride: 3,
};

interface TraceEntry extends IteratePath {
  objectiveVector: PointXY | null;
}

export type ViewportDirtyFlags = Partial<{
  grid: boolean;
  polytope: boolean;
  constraints: boolean;
  objective: boolean;
  trace: boolean;
  iterate: boolean;
}>;

// Repaint everything — for whole-problem swaps (gallery load, shared-state
// import) and mode switches where deriving per-field flags would be noise.
export const ALL_VIEWPORT_DIRTY: ViewportDirtyFlags = {
  grid: true,
  polytope: true,
  constraints: true,
  objective: true,
  trace: true,
  iterate: true,
};

type StateChangeMeta = {
  viewportDirty?: ViewportDirtyFlags;
};

// Which render layers a change to each store field repaints. patch() derives
// `viewportDirty` from the changed fields automatically, so callers no longer
// hand-pick flags (the scattered reverse-index of layer invalidationKeys that
// was the main source of silent missed-repaint bugs). Derivation is additive —
// it is unioned with any explicitly-passed flags and can only add, never drop —
// and fields absent here (pure UI/solver-config state) repaint nothing.
const POLYTOPE_DIRTY: ViewportDirtyFlags = {
  polytope: true,
  constraints: true,
  objective: true,
};
const ITERATE_DIRTY: ViewportDirtyFlags = { iterate: true };
const TRACE_DIRTY: ViewportDirtyFlags = { trace: true };
// the objective marker is occluded by the polytope floor in 3D, so a moved
// objective repaints the polytope too while in (or transitioning to) 3D
const objectiveDirty = (s: State): ViewportDirtyFlags =>
  s.is3DMode || s.isTransitioning3D
    ? { polytope: true, objective: true }
    : { objective: true };

const FIELD_DIRTY: Partial<Record<keyof State, (s: State) => ViewportDirtyFlags>> =
  {
    vertices: () => POLYTOPE_DIRTY,
    polytope: () => POLYTOPE_DIRTY,
    // the start marker renders in the iterate overlay pass
    solverStartPoint: () => ITERATE_DIRTY,
    solverMode: () => ITERATE_DIRTY,
    completionMode: () => POLYTOPE_DIRTY,
    interiorPoint: () => POLYTOPE_DIRTY,
    objectiveVector: objectiveDirty,
    currentObjective: objectiveDirty,
    objectiveHidden: () => ({ objective: true }),
    highlightIndex: () => ({ constraints: true }),
    iteratePath: () => ITERATE_DIRTY,
    iteratePhases: () => ITERATE_DIRTY,
    iterateRestartIndices: () => ITERATE_DIRTY,
    iterateObjectiveVector: () => ITERATE_DIRTY,
    highlightIteratePathIndex: () => ITERATE_DIRTY,
    traceBuffer: () => TRACE_DIRTY,
    traceEnabled: () => TRACE_DIRTY,
    // zScale rescales every world-anchored layer's height
    zScale: () => ({
      polytope: true,
      objective: true,
      trace: true,
      iterate: true,
    }),
  };

export function deriveViewportDirty(
  state: State,
  changedKeys: readonly (keyof State)[],
): ViewportDirtyFlags | null {
  let flags: ViewportDirtyFlags | null = null;
  for (const key of changedKeys) {
    const derive = FIELD_DIRTY[key];
    if (!derive) continue;
    // build a fresh object (never mutate the shared flag constants)
    flags = Object.assign(flags ?? {}, derive(state));
  }
  return flags;
}

export type SolverSettings = {
  alphaMax: number;
  correctorThreshold: number;
  maxitIPM: number;
  simplexDualMode: boolean;
  simplexEnteringRule: EnteringRule;
  simplexLeavingRule: LeavingRule;
  pdhgEta: number;
  pdhgTau: number;
  maxitPDHG: number;
  pdhgIneqMode: boolean;
  pdhgHalpernMode: boolean;
  pdhgColorByBasis: boolean;
  centralPathIter: number;
  objectiveAngleStep: number;
  objectiveRotationSpeed: number;
  replaySpeed: number;
};

const DEFAULT_SOLVER_SETTINGS: SolverSettings = {
  alphaMax: 0.1,
  correctorThreshold: 0.9,
  maxitIPM: 1000,
  simplexDualMode: false,
  simplexEnteringRule: "first",
  simplexLeavingRule: "first",
  pdhgEta: 0.25,
  pdhgTau: 0.25,
  maxitPDHG: 1000,
  pdhgIneqMode: true,
  pdhgHalpernMode: false,
  pdhgColorByBasis: false,
  centralPathIter: 75,
  objectiveAngleStep: 0.1,
  objectiveRotationSpeed: 1,
  replaySpeed: 10,
};

export type State = {
  vertices: PointXY[];
  completionMode: CompletionMode;
  interiorPoint: PointXY | null;
  polytope: PolytopeRepresentation | null;
  inequalitiesMessage: string | null;
  resultDisplayMode: "usage" | "blocks" | "virtual";
  resultBlocks: ResultTextBlock[] | null;
  resultVirtualHeader: string | null;
  resultVirtualFooter: string | null;
  resultVirtualShowEmpty: boolean;
  resultVirtualRows: VirtualRowBlocks;
  resultMaxLineChars: number;

  objectiveVector: PointXY | null;
  currentObjective: PointXY | null;
  objectiveHidden: boolean;

  solverMode: SolverMode;
  solverSettings: SolverSettings;
  // Where IPM/PDHG/primal-simplex begin iterating; null = the solver default
  // (origin). Draggable via the canvas marker.
  solverStartPoint: PointXY | null;
  iteratePath: IteratePath;
  iteratePhases: number[];
  highlightIteratePathIndex: number | null;
  rotateObjectiveMode: boolean;
  animationIntervalId: number | null;
  originalIteratePath: IteratePath;
  originalIteratePhases: number[];
  iterateRestartIndices: number[];
  iterateObjectiveVector: PointXY | null;
  originalIterateObjectiveVector: PointXY | null;

  snapToGrid: boolean;
  highlightIndex: number | null;
  editorInteraction: EditorInteractionState;
  lastCompletedInteraction: CompletedInteraction;

  historyStack: HistoryEntry[];
  redoStack: HistoryEntry[];

  is3DMode: boolean;
  viewAngle: PointXYZ;
  zScale: number;
  isTransitioning3D: boolean;
  transitionStartTime: number;
  transition3DStartAngles: PointXYZ;
  transition3DEndAngles: PointXYZ;
  transitionDirection: "to3d" | "to2d" | null;
  transitionProgress: number;

  traceEnabled: boolean;
  traceBuffer: TraceEntry[];
  maxTraceCount: number;
  isNavigatingViewport: boolean;
};

const initialState: State = {
  vertices: [],
  completionMode: "draft",
  interiorPoint: null,
  polytope: null,
  inequalitiesMessage: null,
  resultDisplayMode: "usage",
  resultBlocks: null,
  resultVirtualHeader: null,
  resultVirtualFooter: null,
  resultVirtualShowEmpty: false,
  resultVirtualRows: [],
  resultMaxLineChars: 0,

  objectiveVector: null,
  currentObjective: null,
  objectiveHidden: false,

  solverMode: "central",
  solverSettings: { ...DEFAULT_SOLVER_SETTINGS },
  solverStartPoint: null,
  iteratePath: EMPTY_ITERATE_PATH,
  iteratePhases: [],
  highlightIteratePathIndex: null,
  rotateObjectiveMode: false,
  animationIntervalId: null,
  originalIteratePath: EMPTY_ITERATE_PATH,
  originalIteratePhases: [],
  iterateRestartIndices: [],
  iterateObjectiveVector: null,
  originalIterateObjectiveVector: null,

  snapToGrid: false,
  highlightIndex: null,
  editorInteraction: { kind: "idle" },
  lastCompletedInteraction: "none",

  historyStack: [],
  redoStack: [],

  is3DMode: false,
  viewAngle: { ...DEFAULT_VIEW_ANGLE },
  zScale: DEFAULT_Z_SCALE,
  isTransitioning3D: false,
  transitionStartTime: 0,
  transition3DStartAngles: { x: 0, y: 0, z: 0 },
  transition3DEndAngles: { ...DEFAULT_VIEW_ANGLE },
  transitionDirection: null,
  transitionProgress: 0,

  traceEnabled: false,
  traceBuffer: [],
  maxTraceCount: 0,
  isNavigatingViewport: false,
};

type Listener = () => void;

type StateValues<K extends keyof State> = { [P in K]: State[P] };
type MetaListener = (meta?: StateChangeMeta) => void;

class LpvizStore {
  private values: State;
  private listeners = new Map<keyof State, Listener[]>();
  private metaListeners: MetaListener[] = [];
  private pending: Listener[] = [];

  constructor(initialValues: State) {
    this.values = initialValues;
  }

  getState(): Readonly<State> {
    return this.values;
  }

  getSnapshot(): State {
    return { ...this.values };
  }

  patch(partial: Partial<State>, meta?: StateChangeMeta): void {
    const changedKeys: (keyof State)[] = [];
    let nextValues: State | null = null;

    for (const rawKey in partial) {
      const key = rawKey as keyof State;
      const value = partial[key];
      if (Object.is(this.values[key], value)) continue;
      nextValues ??= { ...this.values };
      (nextValues as Record<keyof State, State[keyof State]>)[key] =
        value as State[keyof State];
      changedKeys.push(key);
    }

    if (nextValues) {
      this.values = nextValues;
      for (const key of changedKeys) {
        const ls = this.listeners.get(key);
        if (!ls) continue;
        for (let i = 0; i < ls.length; i++) ls[i]!();
      }
      this.flush();
    }

    // viewportDirty is the union of what the changed fields imply and anything
    // the caller passed explicitly (see FIELD_DIRTY)
    const derived = nextValues
      ? deriveViewportDirty(this.values, changedKeys)
      : null;
    if (meta === undefined && derived === null) return;
    let merged: StateChangeMeta = meta ?? {};
    if (derived !== null) {
      merged = {
        ...merged,
        viewportDirty: { ...merged.viewportDirty, ...derived },
      };
    }
    const listeners = this.metaListeners.slice();
    for (let i = 0; i < listeners.length; i++) listeners[i]!(merged);
  }

  on<K extends keyof State>(
    keys: readonly K[],
    fn: (values: StateValues<K>) => void,
    signal: AbortSignal,
  ): void {
    if (signal.aborted) return;

    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const snap = {} as StateValues<K>;
      for (const key of keys) snap[key] = this.values[key];
      fn(snap);
    };
    const handler = () => {
      if (scheduled) return;
      scheduled = true;
      this.pending.push(flush);
    };

    for (const key of keys) {
      const ls = this.listeners.get(key);
      if (ls) ls.push(handler);
      else this.listeners.set(key, [handler]);
    }

    signal.addEventListener(
      "abort",
      () => {
        for (const key of keys) {
          const ls = this.listeners.get(key);
          if (!ls) continue;
          const index = ls.indexOf(handler);
          if (index >= 0) ls.splice(index, 1);
          if (ls.length === 0) this.listeners.delete(key);
        }
      },
      { once: true },
    );
  }

  onMeta(fn: MetaListener, signal: AbortSignal): void {
    if (signal.aborted) return;
    this.metaListeners.push(fn);
    signal.addEventListener(
      "abort",
      () => {
        const index = this.metaListeners.indexOf(fn);
        if (index >= 0) this.metaListeners.splice(index, 1);
      },
      { once: true },
    );
  }

  private flush(): void {
    while (this.pending.length > 0) {
      const pending = this.pending;
      this.pending = [];
      for (let i = 0; i < pending.length; i++) pending[i]!();
    }
  }
}

const lpvizStore = new LpvizStore(initialState);

export function getState(): Readonly<State> {
  return lpvizStore.getState();
}

export function getSnapshot(): State {
  return lpvizStore.getSnapshot();
}

export function setState(patch: Partial<State>, meta?: StateChangeMeta): void {
  lpvizStore.patch(patch, meta);
}

export function on<K extends keyof State>(
  keys: readonly K[],
  fn: (values: StateValues<K>) => void,
  signal: AbortSignal,
): void {
  lpvizStore.on(keys, fn, signal);
}

export function onMeta(
  fn: (meta?: StateChangeMeta) => void,
  signal: AbortSignal,
): void {
  lpvizStore.onMeta(fn, signal);
}

export function computeDrawingPhase(state: State): DrawingPhase {
  const verticesCount = state.vertices.length;
  const regionFinished = state.completionMode !== "draft";
  const hasObjective = state.objectiveVector !== null;

  if (verticesCount === 0) {
    return "empty";
  }
  if (!regionFinished) {
    return "sketching_polytope";
  }
  if (!hasObjective) {
    return state.currentObjective !== null
      ? "objective_preview"
      : "awaiting_objective";
  }
  return "ready_for_solvers";
}

// Solver default start: IPM/PDHG begin at the origin, and Phase-1 simplex's
// first displayed iterate is the origin too (all structural variables start
// nonbasic), so one marker default is truthful for all three.
const DEFAULT_SOLVER_START: Readonly<PointXY> = { x: 0, y: 0 };

/** Whether the draggable start marker applies to the current solver/problem. */
function solverStartPointApplies(state: State): boolean {
  if (computeDrawingPhase(state) !== "ready_for_solvers") return false;
  if (!hasPolytopeLines(state.polytope)) return false;
  if (state.polytope.kind !== "bounded" && state.polytope.kind !== "unbounded")
    return false;
  if (state.solverMode === "ipm" || state.solverMode === "pdhg") return true;
  // dual simplex has no safe start-point interpretation: a primal point only
  // determines a dual-feasible basis when it is already optimal
  return state.solverMode === "simplex" && !state.solverSettings.simplexDualMode;
}

/** Nearest vertex of the feasible region, or null if there are none. */
export function nearestPolytopeVertex(
  state: State,
  point: PointXY,
): PointXY | null {
  if (!hasPolytopeLines(state.polytope)) return null;
  let best: PointXY | null = null;
  let bestDistance = Infinity;
  for (const vertex of state.polytope.vertices) {
    const distance = Math.hypot(vertex[0]! - point.x, vertex[1]! - point.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { x: vertex[0]!, y: vertex[1]! };
    }
  }
  return best;
}

/**
 * The marker position to draw: the dragged point (snapped to the nearest
 * region vertex in simplex mode, which is how simplex consumes it), or the
 * solver default when nothing has been dragged yet. Null when hidden.
 */
export function displayedSolverStartPoint(state: State): PointXY | null {
  if (!solverStartPointApplies(state)) return null;
  const point = state.solverStartPoint;
  if (!point) return { ...DEFAULT_SOLVER_START };
  if (state.solverMode === "simplex") {
    return nearestPolytopeVertex(state, point) ?? point;
  }
  return point;
}

export function prepareAnimationInterval(): void {
  const { animationIntervalId } = getState();
  if (animationIntervalId !== null) {
    clearInterval(animationIntervalId);
    setState({ animationIntervalId: null });
  }
}

export function updateIteratePaths(
  path: IteratePath,
  phasesArray?: number[],
  restartIndicesArray?: number[],
): void {
  const { objectiveVector } = getState();
  // viewportDirty derived from the changed iterate fields (see FIELD_DIRTY)
  setState(
    buildIterateStatePatch(
      path,
      phasesArray,
      restartIndicesArray,
      snapshotObjectiveVector(objectiveVector),
    ),
  );
}

export function clearIterateState(): void {
  setState({
    ...buildIterateStatePatch(EMPTY_ITERATE_PATH, undefined, undefined, null),
    highlightIteratePathIndex: null,
  });
}

export function addTraceToBuffer(path: IteratePath): void {
  const state = getState();
  if (!state.traceEnabled || path.count === 0) return;
  setState({
    traceBuffer: appendedTraceBuffer(
      state,
      path,
      snapshotObjectiveVector(state.objectiveVector),
    ),
  });
}

// Display z for one iterate at points[base..base+stride): the baked total
// (component [2], present for pdhg/ipm) minus the current objective value, so
// 2D-projected solves render flat and the 3D height tracks the extra term.
export function computeFlatZ(
  points: Float64Array,
  base: number,
  stride: number,
  objectiveVector: PointXY | null,
): number {
  const objectiveValue = objectiveVector
    ? objectiveVector.x * points[base]! + objectiveVector.y * points[base + 1]!
    : 0;
  const totalValue = stride >= 3 ? points[base + 2]! : objectiveValue;
  return totalValue - objectiveValue;
}

export function getDisplayedIterateZ(
  entry: Float64Array,
  objectiveOverride?: PointXY | null,
): number {
  const { objectiveVector: currentObjective } = getState();
  const objectiveVector =
    objectiveOverride === undefined ? currentObjective : objectiveOverride;
  return computeFlatZ(entry, 0, entry.length, objectiveVector);
}

export function updateIteratePathsWithTrace(
  path: IteratePath,
  phasesArray?: number[],
  restartIndicesArray?: number[],
): void {
  const state = getState();
  const objectiveSnapshot = snapshotObjectiveVector(state.objectiveVector);
  const patch: Partial<State> = buildIterateStatePatch(
    path,
    phasesArray,
    restartIndicesArray,
    objectiveSnapshot,
  );
  if (state.traceEnabled && path.count > 0) {
    patch.traceBuffer = appendedTraceBuffer(state, path, objectiveSnapshot);
  }
  // iterate (+ trace, if a chunk was appended) derived from the patched fields
  setState(patch);
}

function snapshotObjectiveVector(objectiveVector: PointXY | null) {
  return objectiveVector ? { ...objectiveVector } : null;
}
// Collapse a solver's per-iterate Float64Arrays into one flat IteratePath
// (simplex / central path, whose iterates live in independent buffers). Packed
// pdhg/ipm results never come through here — they arrive already flat from the
// worker (see unpackIteratePath).
export function flattenIteratesToPath(
  iteratesArray: Float64Array[],
): IteratePath {
  const count = iteratesArray.length;
  if (count === 0) return EMPTY_ITERATE_PATH;
  const stride = iteratesArray[0]!.length >= 3 ? 3 : 2;
  const points = new Float64Array(count * stride);
  for (let i = 0; i < count; i++) {
    const it = iteratesArray[i]!;
    points[i * stride] = it[0] ?? 0;
    points[i * stride + 1] = it[1] ?? 0;
    if (stride >= 3) points[i * stride + 2] = it[2] ?? 0;
  }
  return { points, count, stride };
}

function appendedTraceBuffer(
  state: State,
  path: IteratePath,
  objectiveSnapshot: PointXY | null,
): TraceEntry[] {
  // The trace chunk shares the iterate path's flat buffer (one object, no copy).
  const entry: TraceEntry = {
    points: path.points,
    count: path.count,
    stride: path.stride,
    objectiveVector: snapshotObjectiveVector(objectiveSnapshot),
  };
  const raw = [...state.traceBuffer, entry];
  return raw.length > state.maxTraceCount
    ? raw.slice(raw.length - state.maxTraceCount)
    : raw;
}

function buildIterateStatePatch(
  path: IteratePath,
  phasesArray: number[] | undefined,
  restartIndicesArray: number[] | undefined,
  objectiveSnapshot: PointXY | null,
): Partial<State> {
  // The flat path and phase/restart arrays are never mutated after creation
  // (replay grows a fresh IteratePath over the same shared buffer), so the
  // "original" fields can share them instead of deep-copying.
  return {
    originalIteratePath: path,
    iteratePath: path,
    iteratePhases: phasesArray ?? [],
    originalIteratePhases: phasesArray ?? [],
    iterateRestartIndices: restartIndicesArray ?? [],
    iterateObjectiveVector: objectiveSnapshot,
    originalIterateObjectiveVector: snapshotObjectiveVector(objectiveSnapshot),
  };
}

export function resetTraceState(): void {
  if (getState().traceBuffer.length === 0) return;
  setState({ traceBuffer: [] });
}

export function setTraceCapacity(maxTraceCount: number): void {
  const { traceBuffer } = getState();
  // a repaint is derived only when traceBuffer actually changes (eviction);
  // a capacity-only bump draws the same chunks
  setState({
    maxTraceCount,
    traceBuffer:
      traceBuffer.length > maxTraceCount
        ? traceBuffer.slice(traceBuffer.length - maxTraceCount)
        : traceBuffer,
  });
}
