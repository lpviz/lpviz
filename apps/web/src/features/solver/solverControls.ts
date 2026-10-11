import { getState, type State } from "@/features/core/store";
import { displayedSolverStartPoint, hasUnboundedObjectiveDirection, isEmptyRegion } from "@/features/problem/selectors";
import { messageBlocks, type ResultRenderPayload } from "@/features/solver/resultPresenter";
import { type SolverMode } from "@/features/solver/solverSettings";
import type { Problem, SolverWorkerPayload } from "@/features/solver/types";
import type { Vec } from "@lpviz/math/types";
import { hasConstraints, type Polytope } from "@lpviz/polytope/polytope";

// What each solver mode needs from the problem: the reason it cannot run, as the result panel
// shows it, or the request the worker runs.
export type SolverControl = {
  /** why the solver cannot run on this problem, as the panel shows it, or null when it can */
  blocker: (state: State) => ResultRenderPayload | null;
  buildRequest: (state: State) => SolverWorkerPayload | null;
};

// the problem every request carries and the region it came from
type Solvable = { polytope: Polytope; problem: Problem };

// null while the drawing has no region or no objective
function solvableProblem(state: State): Solvable | null {
  if (!state.objectiveVector || !hasConstraints(state.polytope)) return null;
  return { polytope: state.polytope, problem: { constraints: state.polytope.constraints, objective: Float64Array.from(state.objectiveVector) } };
}

// What a mode asks of the problem beyond a region with an objective: what it says of an empty
// region (pdhg runs on one), any further reason not to run, and the request it builds.
type SolverSpec = {
  emptyRegion?: string;
  alsoBlocked?: (state: State) => ResultRenderPayload | null;
  request: (state: State, solvable: Solvable) => SolverWorkerPayload;
};

const control = ({ emptyRegion, alsoBlocked, request }: SolverSpec): SolverControl => ({
  blocker: (s) => (emptyRegion !== undefined && isEmptyRegion(s) ? emptyRegionBlock(emptyRegion) : (alsoBlocked?.(s) ?? null)),
  buildRequest: (s) => {
    const solvable = solvableProblem(s);
    return solvable && request(s, solvable);
  },
});

// The points the ellipsoid family builds its initial localization around. A
// bounded region's vertices are its polytope's. An unbounded region's polytope
// carries none, but every vertex it has is an interior point of the drawn chain
// (the end edges continue as rays), so the chain bounds them all. Without it
// the engine falls back to a fixed box around the origin, which has no relation
// to the drawing.
function regionBoundingVertices(state: State): Vec[] {
  const vertices = state.polytope?.vertices ?? [];
  return vertices.length > 0 ? vertices : state.vertices;
}

// The start the user dragged, as the solver takes it (see displayedSolverStartPoint), or null when
// never dragged: the solvers then keep their exact legacy initialization.
const requestedStartPoint = (state: State): Vec | null => (state.solverStartPoint ? displayedSolverStartPoint(state) : null);

// a slider at 0 (or cleared) still runs one iteration
const iterations = (count: number) => Math.max(1, count || 1);

const emptyRegionBlock = (message: string): ResultRenderPayload => messageBlocks("No valid region", message);
const unboundedObjectiveBlock = messageBlocks(
  "Solver unavailable",
  "Central Path is disabled when the objective points in an unbounded direction. Select IPM, PDHG, or Simplex to see how they handle this unbounded problem.",
);

export const SOLVER_CONTROLS: Record<SolverMode, SolverControl> = {
  central: control({
    emptyRegion: "Central Path requires a feasible region.",
    alsoBlocked: (s) => (hasUnboundedObjectiveDirection(s) ? unboundedObjectiveBlock : null),
    request: (s, { polytope, problem }) => ({
      solver: "central",
      vertices: polytope.vertices,
      ...problem,
      niter: iterations(s.solverSettings.centralPathIter),
    }),
  }),
  ipm: control({
    emptyRegion: "IPM requires a feasible region.",
    request: (s, { problem }) => {
      const settings = s.solverSettings;
      const startPoint = requestedStartPoint(s);
      return {
        solver: "ipm",
        ...problem,
        ...(startPoint ? { startPoint } : {}),
        alphaMax: settings.alphaMax,
        correctorThreshold: settings.correctorThreshold,
        maxit: iterations(settings.maxitIPM),
      };
    },
  }),
  simplex: control({
    emptyRegion: "Simplex requires a valid feasible region.",
    request: (s, { problem }) => {
      // simplex consumes the start as a vertex (the marker snaps to one); dual mode ignores it
      const startVertex = requestedStartPoint(s);
      return {
        solver: "simplex",
        ...problem,
        ...(startVertex ? { startVertex } : {}),
        dual: s.solverSettings.simplexDualMode,
        enteringRule: s.solverSettings.simplexEnteringRule,
        leavingRule: s.solverSettings.simplexLeavingRule,
      };
    },
  }),
  ellipsoid: control({
    emptyRegion: "The ellipsoid method requires a feasible region.",
    request: (s, { problem }) => {
      const settings = s.solverSettings;
      return {
        solver: "ellipsoid",
        // the drawn region bounds the initial ellipsoid (or box)
        vertices: regionBoundingVertices(s),
        ...problem,
        maxit: iterations(settings.maxitEllipsoid),
        deepCuts: settings.ellipsoidDeepCuts,
        rayShoot: settings.ellipsoidRayShoot,
        queryPoint: settings.ellipsoidQueryPoint,
        initialScale: settings.ellipsoidInitialScale,
      };
    },
  }),
  pdhg: control({
    request: (s, { problem }) => {
      const settings = s.solverSettings;
      const startPoint = requestedStartPoint(s);
      return {
        solver: "pdhg",
        ...problem,
        ...(startPoint ? { startPoint } : {}),
        ineq: settings.pdhgIneqMode,
        halpern: settings.pdhgHalpernMode,
        maxit: iterations(settings.maxitPDHG),
        eta: settings.pdhgEta,
        tau: settings.pdhgTau,
        colorByBasis: settings.pdhgColorByBasis,
      };
    },
  }),
};

/** The control of the solver mode the store has selected. */
export const activeSolverControl = () => SOLVER_CONTROLS[getState().solverMode];
