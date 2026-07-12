import type { ResultTextBlock } from "@/features/solver/types";

// Result rows materialize (format) lazily on access so a 100k-iteration solve
// doesn't pay for formatting rows that are never scrolled into view. Plain
// arrays satisfy this shape, which keeps empty-state assignments simple.
type VirtualRowBlocks = {
  length: number;
  at(index: number): ResultTextBlock | undefined;
};
import { DEFAULT_REPLAY_DURATION_MS } from "@/features/solver/replayDuration";
import type { Line, PointXY, PointXYZ } from "@lpviz/math/types";
import {
  hasPolytopeLines,
  type PolytopeRepresentation,
} from "@lpviz/polytope/polytopeTypes";
import type { EnteringRule, LeavingRule } from "@lpviz/solver-engine/simplex";
import type { Plane3, Polytope3Representation } from "@lpviz/polytope/polytope3";
import { DEFAULT_VIEW_ANGLE, DEFAULT_Z_SCALE } from "@lpviz/viewport/defaults";

export const MAX_TRACE_POINT_SPRITES = 1200;
export { DEFAULT_VIEW_ANGLE, DEFAULT_Z_SCALE };

export type SolverMode =
  | "central"
  | "ipm"
  | "simplex"
  | "pdhg"
  | "ellipsoid";
// Which point of the localizing set the ellipsoid mode queries next. "ellipsoid"
// is the ellipsoid method proper (localize with a covering ellipsoid, query its
// center); the rest localize with a polyhedron of accumulated cuts and differ
// only in which interior point they pick. See @lpviz/solver-engine/cuttingPlane.
export type EllipsoidQueryPoint =
  | "ellipsoid"
  | "chebyshev"
  | "analytic"
  | "volumetric";
export type CompletionMode = "draft" | "closed" | "open";
// Which problem the app is editing: the classic 2-variable LP, or the
// 3-variable LP served at /3d. Fixed at boot from the URL path.
type ProblemMode = "2d" | "3d";
// CAD-style build phases for the 3-variable editor: sketch the base polygon on
// the ground plane, extrude it to a prism, pick the objective direction, then
// solve ("ready" keeps faces editable via push/pull and vertex chamfer).
export type Editor3Phase = "sketch" | "extrude" | "objective" | "ready";
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
  // present only in 3D problem mode (undo/redo spans extrude and solid edits)
  vertices3?: PointXYZ[];
  objectiveVector3?: PointXYZ | null;
  editor3Phase?: Editor3Phase;
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
    }
  // 3D problem mode: extrude-handle drag sets the prism height; face3 is a
  // push/pull along the picked face's fixed normal (anchor lies on the face,
  // so newD = anchorD + distance dragged along the normal); vertex3 drags a
  // solid vertex on the camera-facing plane through its start position;
  // objective3 re-aims the 3D objective arrow the same way.
  | { kind: "extrude-handle" }
  | {
      kind: "face3";
      anchorPoint: PointXYZ;
      normal: PointXYZ;
      anchorD: number;
    }
  // `axis` constrains the drag to a line through `anchor` (set for handles
  // inserted on a face, so pulling them out follows the face normal instead
  // of the camera plane — a camera-plane drag usually lands them uselessly
  // inside the solid)
  | { kind: "vertex3"; index: number; anchor: PointXYZ; axis?: PointXYZ }
  | { kind: "objective3" };
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

// The ellipsoid method's per-iteration ellipse, parallel to the iterate path:
// element `i` is [cx, cy, p11, p12, p22] — the center and the symmetric shape
// matrix P of { x : (x - c)' P^-1 (x - c) <= 1 }. Null for every other solver.
export interface EllipsoidPath {
  data: Float64Array;
  count: number;
  stride: number;
}

// The cutting-plane query points localize with a polyhedron rather than an
// ellipsoid, so they also emit that polygon per iteration: element `i` spans
// points[offsets[i] * 2 .. offsets[i + 1] * 2). Null for the ellipsoid method,
// whose localizing set is the ellipse already in EllipsoidPath.
export interface LocalizingSetPath {
  points: Float64Array;
  offsets: Uint32Array;
  count: number;
}

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
const objectiveDirty = (s: State): ViewportDirtyFlags => (s.is3DMode || s.isTransitioning3D ? { polytope: true, objective: true } : { objective: true });

const FIELD_DIRTY: Partial<Record<keyof State, (s: State) => ViewportDirtyFlags>> =
  {
    vertices: () => POLYTOPE_DIRTY,
    polytope: () => POLYTOPE_DIRTY,
    // the start marker renders in the iterate overlay pass
    solverStartPoint: () => ITERATE_DIRTY,
    solverMode: () => ITERATE_DIRTY,
    completionMode: () => POLYTOPE_DIRTY,
    interiorPoint: () => POLYTOPE_DIRTY,
    vertices3: () => POLYTOPE_DIRTY,
    planes: () => POLYTOPE_DIRTY,
    polytope3: () => POLYTOPE_DIRTY,
    editor3Phase: () => POLYTOPE_DIRTY,
    extrudePreviewHeight: () => POLYTOPE_DIRTY,
    hoveredFaceIndex: () => ({ constraints: true }),
    objectiveVector3: () => ({ objective: true }),
    currentObjective3: () => ({ objective: true }),
    objectiveVector: objectiveDirty,
    currentObjective: objectiveDirty,
    objectiveHidden: () => ({ objective: true }),
    highlightIndex: () => ({ constraints: true }),
    iteratePath: () => ITERATE_DIRTY,
    iterateEllipsoids: () => ITERATE_DIRTY,
    iterateLocalizingSets: () => ITERATE_DIRTY,
    iteratePhases: () => ITERATE_DIRTY,
    iterateRestartIndices: () => ITERATE_DIRTY,
    iterateObjectiveVector: () => ITERATE_DIRTY,
    highlightIteratePathIndex: () => ITERATE_DIRTY,
    // the optimum star is hidden for the duration of a replay, so starting or
    // stopping one changes what the iterate pass draws (see IterateStarLayer)
    replayActive: () => ITERATE_DIRTY,
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
  maxitEllipsoid: number;
  ellipsoidDeepCuts: boolean;
  ellipsoidRayShoot: boolean;
  ellipsoidQueryPoint: EllipsoidQueryPoint;
  ellipsoidInitialScale: number;
  objectiveAngleStep: number;
  objectiveRotationSpeed: number;
  // Total wall-clock length of an "Animate" replay in milliseconds — not a
  // per-step delay: the replay maps elapsed time onto the whole iterate path,
  // so it takes just as long at 20 iterates as at 20,000 (see
  // replayController). Adjusted with the +/- keys; the name is left over from
  // when it was a per-step delay.
  replaySpeed: number;
};

// exported so share links can omit any setting still at its default
export const DEFAULT_SOLVER_SETTINGS: SolverSettings = {
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
  maxitEllipsoid: 500,
  ellipsoidDeepCuts: true,
  ellipsoidRayShoot: true,
  ellipsoidQueryPoint: "ellipsoid",
  ellipsoidInitialScale: 1.5,
  objectiveAngleStep: 0.1,
  objectiveRotationSpeed: 1,
  replaySpeed: DEFAULT_REPLAY_DURATION_MS,
};

export type State = {
  problemMode: ProblemMode;
  editor3Phase: Editor3Phase;
  // 3-variable problem. `vertices3` is the source of truth (V-rep, like the
  // 2D editor); `polytope3` is its convex hull and `planes` mirrors
  // polytope3.planes for hit-testing/solving. The 2D `vertices`/`polytope`
  // fields double as the sketch-phase base polygon.
  vertices3: PointXYZ[];
  planes: Plane3[];
  polytope3: Polytope3Representation | null;
  objectiveVector3: PointXYZ | null;
  currentObjective3: PointXYZ | null;
  // live prism height while the extrude handle is being dragged (null = idle)
  extrudePreviewHeight: number | null;
  hoveredFaceIndex: number | null;

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
  iterateEllipsoids: EllipsoidPath | null;
  iterateLocalizingSets: LocalizingSetPath | null;
  iteratePhases: number[];
  highlightIteratePathIndex: number | null;
  rotateObjectiveMode: boolean;
  // "an Animate replay is playing out" — the replay's RAF handle stays private
  // to replayController (it changes every frame, and a store field that churned
  // at 60Hz would invalidate every selector keyed on it)
  replayActive: boolean;
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
  problemMode: "2d",
  editor3Phase: "sketch",
  vertices3: [],
  planes: [],
  polytope3: null,
  objectiveVector3: null,
  currentObjective3: null,
  extrudePreviewHeight: null,
  hoveredFaceIndex: null,

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
  iterateEllipsoids: null,
  iterateLocalizingSets: null,
  iteratePhases: [],
  highlightIteratePathIndex: null,
  rotateObjectiveMode: false,
  replayActive: false,
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
      (nextValues as Record<keyof State, State[keyof State]>)[key] = value as State[keyof State];
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
    const derived = nextValues ? deriveViewportDirty(this.values, changedKeys) : null;
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

  on<K extends keyof State>(keys: readonly K[], fn: (values: StateValues<K>) => void, signal: AbortSignal): void {
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

export function on<K extends keyof State>(keys: readonly K[], fn: (values: StateValues<K>) => void, signal: AbortSignal): void {
  lpvizStore.on(keys, fn, signal);
}

export function onMeta(fn: (meta?: StateChangeMeta) => void, signal: AbortSignal): void {
  lpvizStore.onMeta(fn, signal);
}

export function computeDrawingPhase(state: State): DrawingPhase {
  if (state.problemMode === "3d") {
    switch (state.editor3Phase) {
      case "sketch":
        return state.vertices.length === 0 ? "empty" : "sketching_polytope";
      case "extrude":
        return "sketching_polytope";
      case "objective":
        return state.currentObjective3 !== null ? "objective_preview" : "awaiting_objective";
      case "ready":
        return "ready_for_solvers";
    }
  }
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
    return state.currentObjective !== null ? "objective_preview" : "awaiting_objective";
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

export function updateIteratePaths(
  path: IteratePath,
  phasesArray?: number[],
  restartIndicesArray?: number[],
  ellipsoids?: EllipsoidPath | null,
  localizingSets?: LocalizingSetPath | null,
): void {
  const { objectiveVector } = getState();
  // viewportDirty derived from the changed iterate fields (see FIELD_DIRTY)
  setState(
    buildIterateStatePatch(
      path,
      phasesArray,
      restartIndicesArray,
      snapshotObjectiveVector(objectiveVector),
      ellipsoids ?? null,
      localizingSets ?? null,
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
    traceBuffer: appendedTraceBuffer(state, path, snapshotObjectiveVector(state.objectiveVector)),
  });
}

// Display z for one iterate at points[base..base+stride): the baked total
// (component [2], present for pdhg/ipm) minus the current objective value, so
// 2D-projected solves render flat and the 3D height tracks the extra term.
export function computeFlatZ(points: Float64Array, base: number, stride: number, objectiveVector: PointXY | null): number {
  const objectiveValue = objectiveVector ? objectiveVector.x * points[base]! + objectiveVector.y * points[base + 1]! : 0;
  const totalValue = stride >= 3 ? points[base + 2]! : objectiveValue;
  return totalValue - objectiveValue;
}

export function getDisplayedIterateZ(entry: Float64Array, objectiveOverride?: PointXY | null): number {
  const { objectiveVector: currentObjective } = getState();
  const objectiveVector = objectiveOverride === undefined ? currentObjective : objectiveOverride;
  return computeFlatZ(entry, 0, entry.length, objectiveVector);
}

export function updateIteratePathsWithTrace(
  path: IteratePath,
  phasesArray?: number[],
  restartIndicesArray?: number[],
  ellipsoids?: EllipsoidPath | null,
  localizingSets?: LocalizingSetPath | null,
): void {
  const state = getState();
  const objectiveSnapshot = snapshotObjectiveVector(state.objectiveVector);
  const patch: Partial<State> = buildIterateStatePatch(
    path,
    phasesArray,
    restartIndicesArray,
    objectiveSnapshot,
    ellipsoids ?? null,
    localizingSets ?? null,
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
export function flattenIteratesToPath(iteratesArray: Float64Array[]): IteratePath {
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

function appendedTraceBuffer(state: State, path: IteratePath, objectiveSnapshot: PointXY | null): TraceEntry[] {
  // The trace chunk shares the iterate path's flat buffer (one object, no copy).
  const entry: TraceEntry = {
    points: path.points,
    count: path.count,
    stride: path.stride,
    objectiveVector: snapshotObjectiveVector(objectiveSnapshot),
  };
  const raw = [...state.traceBuffer, entry];
  return raw.length > state.maxTraceCount ? raw.slice(raw.length - state.maxTraceCount) : raw;
}

function buildIterateStatePatch(
  path: IteratePath,
  phasesArray: number[] | undefined,
  restartIndicesArray: number[] | undefined,
  objectiveSnapshot: PointXY | null,
  ellipsoids: EllipsoidPath | null = null,
  localizingSets: LocalizingSetPath | null = null,
): Partial<State> {
  // The flat path and phase/restart arrays are never mutated after creation
  // (replay grows a fresh IteratePath over the same shared buffer), so the
  // "original" fields can share them instead of deep-copying.
  return {
    originalIteratePath: path,
    iteratePath: path,
    // every solver but the ellipsoid method passes none, which clears the
    // previous solve's ellipses
    iterateEllipsoids: ellipsoids,
    iterateLocalizingSets: localizingSets,
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
    traceBuffer: traceBuffer.length > maxTraceCount ? traceBuffer.slice(traceBuffer.length - maxTraceCount) : traceBuffer,
  });
}
