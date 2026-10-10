import { getState, type State } from "@/features/core/store";
import { nearestPolytopeVertex } from "@/features/polytope-editor/editorState";
import type { SolverMode } from "@/features/solver/solverState";
import { hasUnboundedObjectiveDirection, isEmptyRegion } from "@/features/problem/selectors";
import type { ResultRenderPayload, SolverWorkerPayload } from "@/features/solver/types";
import type { Vec } from "@lpviz/math/types";
import { hasConstraints } from "@lpviz/polytope/polytope";

// What each solver mode needs from the problem: the reason it cannot run, as the result panel
// shows it, or the request the worker runs.
export type SolverControl = {
  /** why the solver cannot run on this problem, or null when it can */
  getRunBlock: (state: State) => ResultRenderPayload | null;
  buildRequest: (state: State) => SolverWorkerPayload | null;
};

// the objective vector + constraints guard common to every buildRequest
function objectiveBase(state: State) {
  if (!state.objectiveVector || !hasConstraints(state.polytope)) return null;
  return {
    constraints: state.polytope.constraints,
    objective: Float64Array.from(state.objectiveVector),
  };
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

// The dragged start point as a solver payload, or absent when never set (the
// solvers then keep their exact legacy initialization).
function startPointPayload(state: State): { startPoint?: Vec } {
  const point = state.solverStartPoint;
  return point ? { startPoint: point } : {};
}

const messageBlocks = (header: string, message: string): ResultRenderPayload => ({
  type: "blocks",
  blocks: [
    { className: "iterate-header", text: header },
    { className: "iterate-item-nohover", text: message },
  ],
});

const emptyRegionBlock =
  (message: string): SolverControl["getRunBlock"] =>
  (s) =>
    isEmptyRegion(s) ? messageBlocks("No valid region", message) : null;

export const SOLVER_CONTROLS: Record<SolverMode, SolverControl> = {
  central: {
    getRunBlock: (s) => {
      if (!hasConstraints(s.polytope)) return null;
      if (s.polytope.kind === "empty") return messageBlocks("No valid region", "Central Path requires a feasible region.");
      if (hasUnboundedObjectiveDirection(s))
        return messageBlocks(
          "Solver unavailable",
          "Central Path is disabled when the objective points in an unbounded direction. Select IPM, PDHG, or Simplex to see how they handle this unbounded problem.",
        );
      return null;
    },
    buildRequest: (s) => {
      const base = objectiveBase(s);
      if (!base || !hasConstraints(s.polytope)) return null;
      return {
        solver: "central",
        vertices: s.polytope.vertices,
        ...base,
        niter: Math.max(1, s.solverSettings.centralPathIter || 1),
      };
    },
  },
  ipm: {
    getRunBlock: emptyRegionBlock("IPM requires a feasible region."),
    buildRequest: (s) => {
      const base = objectiveBase(s);
      if (!base) return null;
      const ss = s.solverSettings;
      return {
        solver: "ipm",
        ...base,
        ...startPointPayload(s),
        alphaMax: ss.alphaMax,
        correctorThreshold: ss.correctorThreshold,
        maxit: Math.max(1, ss.maxitIPM || 1),
      };
    },
  },
  simplex: {
    getRunBlock: emptyRegionBlock("Simplex requires a valid feasible region."),
    buildRequest: (s) => {
      const base = objectiveBase(s);
      if (!base) return null;
      // Simplex consumes the start as a vertex (the marker snaps to one);
      // dual mode has no safe start-point interpretation and ignores it.
      const snapped = !s.solverSettings.simplexDualMode && s.solverStartPoint ? nearestPolytopeVertex(s, s.solverStartPoint) : null;
      return {
        solver: "simplex",
        ...base,
        ...(snapped ? { startVertex: snapped } : {}),
        dual: s.solverSettings.simplexDualMode,
        enteringRule: s.solverSettings.simplexEnteringRule,
        leavingRule: s.solverSettings.simplexLeavingRule,
      };
    },
  },
  ellipsoid: {
    getRunBlock: emptyRegionBlock("The ellipsoid method requires a feasible region."),
    buildRequest: (s) => {
      const base = objectiveBase(s);
      if (!base || !hasConstraints(s.polytope)) return null;
      const ss = s.solverSettings;
      return {
        solver: "ellipsoid",
        // the drawn region bounds the initial ellipsoid (or box)
        vertices: regionBoundingVertices(s),
        ...base,
        maxit: Math.max(1, ss.maxitEllipsoid || 1),
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
      const base = objectiveBase(s);
      if (!base) return null;
      const ss = s.solverSettings;
      return {
        solver: "pdhg",
        ...base,
        ...startPointPayload(s),
        ineq: ss.pdhgIneqMode,
        halpern: ss.pdhgHalpernMode,
        maxit: Math.max(1, ss.maxitPDHG || 1),
        eta: ss.pdhgEta,
        tau: ss.pdhgTau,
        colorByBasis: ss.pdhgColorByBasis,
      };
    },
  },
};

/** The control of the solver mode the store has selected. */
export const activeSolverControl = () => SOLVER_CONTROLS[getState().solverMode];
