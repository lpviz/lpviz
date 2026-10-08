import { nearestPolytopeVertex, type EditorState } from "@/features/polytope-editor/editorState";
import { hasFeasibleRegion, isReadyForSolvers } from "@/features/problem/selectors";
import { DEFAULT_REPLAY_DURATION_MS } from "@/features/solver/replayDuration";
import type { Vec } from "@lpviz/math/types";
import { zeroVec } from "@lpviz/math/vec";
import type { QueryPoint } from "@lpviz/solver-engine/cuttingPlane";
import type { EnteringRule, LeavingRule } from "@lpviz/solver-engine/simplex";
import type { ViewportDirtyFlags } from "@/features/viewport/dirtyFlags";

type ResultTextBlockClassName = "iterate-header" | "iterate-item" | "iterate-item-nohover" | "iterate-footer";

export type ResultTextBlock = {
  className: ResultTextBlockClassName;
  text: string;
  index?: number | undefined;
};

export const MAX_TRACE_POINT_SPRITES = 1200;

// Index order is the share link's wire identity (compactUrl): only ever append.
export const SOLVER_MODES = ["central", "ipm", "simplex", "pdhg", "ellipsoid"] as const;
export type SolverMode = (typeof SOLVER_MODES)[number];
// Which point of the localizing set the ellipsoid mode queries next: "ellipsoid" is the ellipsoid
// method proper, the rest localize with a polyhedron of cuts (see @lpviz/solver-engine/cuttingPlane).
export const QUERY_POINTS = ["ellipsoid", "chebyshev", "analytic", "volumetric"] as const satisfies readonly ("ellipsoid" | QueryPoint)[];
export type EllipsoidQueryPoint = (typeof QUERY_POINTS)[number];

// Result rows format lazily on access, so a 100k-iteration solve never formats rows that are not
// scrolled into view; plain arrays satisfy this shape.
type VirtualRowBlocks = {
  length: number;
  at(index: number): ResultTextBlock | undefined;
};

// Flat, contiguous iterate coordinates: iterate `i` lives at [i*stride .. i*stride+stride), with
// `stride` the problem's dimension. `lift[i]` is the height the 3D view raises iterate `i` above the
// floor (the solver's convergence measure, see resultPacking); null for solvers drawn flat. One
// array per solve, not one Float64Array per iterate: millions of live objects is what a major GC
// must mark.
export interface IteratePath {
  points: Float64Array;
  count: number;
  stride: number;
  lift: Float64Array | null;
}

export const EMPTY_ITERATE_PATH: IteratePath = {
  points: new Float64Array(0),
  count: 0,
  stride: 2,
  lift: null,
};

// The ellipsoid family's per-iteration shape, parallel to the iterate path: element `i` is the
// center followed by the upper triangle of the symmetric shape matrix P of
// { x : (x - c)' P^-1 (x - c) <= 1 }, `stride` = ellipsoidStride(n) values ([cx, cy, p11, p12, p22]
// for two variables; see @lpviz/solver-engine/localization). Null for every other solver.
export interface EllipsoidPath {
  data: Float64Array;
  count: number;
  stride: number;
}

// The cutting-plane query points' localizing set per iteration: element `i` spans
// points[offsets[i] * stride .. offsets[i + 1] * stride), a closed polygon's [x, y] vertices for two
// variables (stride 2) and the half-spaces [a1..an, b] of the polyhedron otherwise (stride n + 1).
// Null for the ellipsoid method, whose localizing set is the ellipse already in EllipsoidPath.
export interface LocalizingSetPath {
  points: Float64Array;
  offsets: Uint32Array;
  count: number;
  stride: number;
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
  // Total wall-clock length of an "Animate" replay in milliseconds, not a per-step delay despite
  // the name: the replay maps elapsed time onto the whole iterate path (see replayController).
  // Adjusted with the +/- keys.
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

// The solver's slice of the store: the result panel, the solve and its iterates, and the trace.
export type SolverState = {
  resultDisplayMode: "usage" | "blocks" | "virtual";
  resultBlocks: ResultTextBlock[] | null;
  resultVirtualHeader: string | null;
  resultVirtualFooter: string | null;
  resultVirtualShowEmpty: boolean;
  resultVirtualRows: VirtualRowBlocks;
  resultMaxLineChars: number;

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
    resultDisplayMode: "usage",
    resultBlocks: null,
    resultVirtualHeader: null,
    resultVirtualFooter: null,
    resultVirtualShowEmpty: false,
    resultVirtualRows: [],
    resultMaxLineChars: 0,

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
export const SOLVER_DIRTY: Partial<Record<keyof SolverState, () => ViewportDirtyFlags>> = {
  // the start marker renders in the iterate overlay pass
  solverStartPoint: () => ITERATE_DIRTY,
  solverMode: () => ITERATE_DIRTY,
  iteratePath: () => ITERATE_DIRTY,
  iterateEllipsoids: () => ITERATE_DIRTY,
  iterateLocalizingSets: () => ITERATE_DIRTY,
  iteratePhases: () => ITERATE_DIRTY,
  iterateRestartIndices: () => ITERATE_DIRTY,
  highlightIteratePathIndex: () => ITERATE_DIRTY,
  // the optimum star is hidden for the duration of a replay, so starting or
  // stopping one changes what the iterate pass draws (see IterateStarLayer)
  replayActive: () => ITERATE_DIRTY,
  traceBuffer: () => TRACE_DIRTY,
  traceEnabled: () => TRACE_DIRTY,
};

// Solver default start: IPM/PDHG begin at the origin, and Phase-1 simplex's
// first displayed iterate is the origin too (all structural variables start
// nonbasic), so one marker default is truthful for all three.

/** Whether the draggable start marker applies to the current solver/problem. */
function solverStartPointApplies(state: EditorState & SolverState): boolean {
  if (!isReadyForSolvers(state) || !hasFeasibleRegion(state)) return false;
  if (state.solverMode === "ipm" || state.solverMode === "pdhg") return true;
  // dual simplex has no safe start-point interpretation: a primal point only
  // determines a dual-feasible basis when it is already optimal
  return state.solverMode === "simplex" && !state.solverSettings.simplexDualMode;
}

/**
 * The marker position to draw: the dragged point (snapped to the nearest region vertex in simplex
 * mode, which is how simplex consumes it), or the solver default when nothing has been dragged yet.
 * Null when hidden.
 */
export function displayedSolverStartPoint(state: EditorState & SolverState): Vec | null {
  if (!solverStartPointApplies(state)) return null;
  const point = state.solverStartPoint;
  if (!point) return zeroVec(state.dimension);
  if (state.solverMode === "simplex") {
    return nearestPolytopeVertex(state, point) ?? point;
  }
  return point;
}

// The display height of iterate `index`: a 3-variable problem's third coordinate, otherwise the
// solver's lift above the floor (zero for a solver drawn flat).
export function iterateHeight(path: IteratePath, index: number): number {
  return path.stride >= 3 ? path.points[index * path.stride + 2]! : (path.lift?.[index] ?? 0);
}
