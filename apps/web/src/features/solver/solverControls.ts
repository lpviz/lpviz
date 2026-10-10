import { getState, type State } from "@/features/core/store";
import { hasUnboundedObjectiveDirection, isEmptyRegion } from "@/features/problem/selectors";
import { messageBlocks } from "@/features/solver/resultPresenter";
import type { SolverMode } from "@/features/solver/solverSettings";
import { displayedSolverStartPoint } from "@/features/solver/solverState";
import type { Problem, ResultRenderPayload, SolverWorkerPayload } from "@/features/solver/types";
import type { Vec } from "@lpviz/math/types";
import { hasConstraints, type Polytope } from "@lpviz/polytope/polytope";

// What each solver mode needs from the problem: the reason it cannot run, as the result panel
// shows it, or the request the worker runs.
export type SolverControl = {
  /** why the solver cannot run on this problem, or null when it can */
  getRunBlock: (state: State) => ResultRenderPayload | null;
  buildRequest: (state: State) => SolverWorkerPayload | null;
};

// the problem every request carries and the region it came from, or null while the drawing has
// no region or no objective
function solvableProblem(state: State): { polytope: Polytope; problem: Problem } | null {
  if (!state.objectiveVector || !hasConstraints(state.polytope)) return null;
  return { polytope: state.polytope, problem: { constraints: state.polytope.constraints, objective: Float64Array.from(state.objectiveVector) } };
}

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
  central: {
    getRunBlock: (s) => (isEmptyRegion(s) ? emptyRegionBlock("Central Path requires a feasible region.") : hasUnboundedObjectiveDirection(s) ? unboundedObjectiveBlock : null),
    buildRequest: (s) => {
      const solvable = solvableProblem(s);
      if (!solvable) return null;
      return {
        solver: "central",
        vertices: solvable.polytope.vertices,
        ...solvable.problem,
        niter: iterations(s.solverSettings.centralPathIter),
      };
    },
  },
  ipm: {
    getRunBlock: (s) => (isEmptyRegion(s) ? emptyRegionBlock("IPM requires a feasible region.") : null),
    buildRequest: (s) => {
      const solvable = solvableProblem(s);
      if (!solvable) return null;
      const ss = s.solverSettings;
      const startPoint = requestedStartPoint(s);
      return {
        solver: "ipm",
        ...solvable.problem,
        ...(startPoint ? { startPoint } : {}),
        alphaMax: ss.alphaMax,
        correctorThreshold: ss.correctorThreshold,
        maxit: iterations(ss.maxitIPM),
      };
    },
  },
  simplex: {
    getRunBlock: (s) => (isEmptyRegion(s) ? emptyRegionBlock("Simplex requires a valid feasible region.") : null),
    buildRequest: (s) => {
      const solvable = solvableProblem(s);
      if (!solvable) return null;
      // simplex consumes the start as a vertex (the marker snaps to one); dual mode ignores it
      const startVertex = requestedStartPoint(s);
      return {
        solver: "simplex",
        ...solvable.problem,
        ...(startVertex ? { startVertex } : {}),
        dual: s.solverSettings.simplexDualMode,
        enteringRule: s.solverSettings.simplexEnteringRule,
        leavingRule: s.solverSettings.simplexLeavingRule,
      };
    },
  },
  ellipsoid: {
    getRunBlock: (s) => (isEmptyRegion(s) ? emptyRegionBlock("The ellipsoid method requires a feasible region.") : null),
    buildRequest: (s) => {
      const solvable = solvableProblem(s);
      if (!solvable) return null;
      const ss = s.solverSettings;
      return {
        solver: "ellipsoid",
        // the drawn region bounds the initial ellipsoid (or box)
        vertices: regionBoundingVertices(s),
        ...solvable.problem,
        maxit: iterations(ss.maxitEllipsoid),
        deepCuts: ss.ellipsoidDeepCuts,
        rayShoot: ss.ellipsoidRayShoot,
        queryPoint: ss.ellipsoidQueryPoint,
        initialScale: ss.ellipsoidInitialScale,
      };
    },
  },
  pdhg: {
    getRunBlock: () => null,
    buildRequest: (s) => {
      const solvable = solvableProblem(s);
      if (!solvable) return null;
      const ss = s.solverSettings;
      const startPoint = requestedStartPoint(s);
      return {
        solver: "pdhg",
        ...solvable.problem,
        ...(startPoint ? { startPoint } : {}),
        ineq: ss.pdhgIneqMode,
        halpern: ss.pdhgHalpernMode,
        maxit: iterations(ss.maxitPDHG),
        eta: ss.pdhgEta,
        tau: ss.pdhgTau,
        colorByBasis: ss.pdhgColorByBasis,
      };
    },
  },
};

/** The control of the solver mode the store has selected. */
export const activeSolverControl = () => SOLVER_CONTROLS[getState().solverMode];
