import type { EditorState } from "@/features/polytope-editor/editorState";
import type { SolverMode, SolverSettings } from "@/features/solver/solverSettings";
import type { SolverState } from "@/features/solver/solverState";
import type { Vec } from "@lpviz/math/types";
import { vecDistance, zeroVec } from "@lpviz/math/vec";
import { isObjectiveDirectionUnbounded } from "@lpviz/polytope/halfSpaces";
import { hasConstraints } from "@lpviz/polytope/polytope";

// What the UI and the solver pipeline need to know about the problem, derived in one place from the
// store's fields: how far the drawing has got, whether there is a region, whether it has feasible
// points, whether the objective is set, whether a solve can run, and where a solver starts.

export type DrawingPhase = "empty" | "sketching_polytope" | "awaiting_objective" | "objective_preview" | "ready_for_solvers";

/** The fields the drawing phase is computed from; whoever follows the phase subscribes to exactly these. */
export const DRAWING_PHASE_KEYS = ["vertices", "completionMode", "objectiveVector", "currentObjective"] as const satisfies readonly (keyof EditorState)[];

export function computeDrawingPhase(state: Pick<EditorState, (typeof DRAWING_PHASE_KEYS)[number]>): DrawingPhase {
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

/** Nearest vertex of the feasible region, or null if there are none. */
function nearestPolytopeVertex(state: EditorState, point: Vec): Vec | null {
  if (!hasConstraints(state.polytope)) return null;
  let best: Vec | null = null;
  let bestDistance = Infinity;
  for (const vertex of state.polytope.vertices) {
    const distance = vecDistance(vertex, point);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [...vertex];
    }
  }
  return best;
}

/** The drawing has been derived into a constraint system. */
export const hasRegion = (state: Pick<EditorState, "polytope">): boolean => hasConstraints(state.polytope);

/** The region exists and has feasible points, bounded or not. */
const hasFeasibleRegion = (state: Pick<EditorState, "polytope">): boolean => hasConstraints(state.polytope) && (state.polytope.kind === "bounded" || state.polytope.kind === "unbounded");

/** The region exists but its constraints admit no point. */
export const isEmptyRegion = (state: Pick<EditorState, "polytope">): boolean => hasConstraints(state.polytope) && state.polytope.kind === "empty";

export const hasObjective = (state: Pick<EditorState, "objectiveVector">): boolean => state.objectiveVector !== null;

/** The polygon an open chain closed up into (its region came out bounded), which the drawing shows in its place; null otherwise. */
export const derivedClosure = (state: Pick<EditorState, "completionMode" | "polytope">): Vec[] | null =>
  state.completionMode === "open" && state.polytope?.kind === "bounded" && state.polytope.vertices.length >= 3 ? state.polytope.vertices : null;

/** The fields `isReadyForSolvers` reads. */
export const READY_FOR_SOLVERS_KEYS = [...DRAWING_PHASE_KEYS, "polytope"] as const;

/** The drawing is finished, derived, and has an objective: everything a solve needs. */
export const isReadyForSolvers = (state: Pick<EditorState, (typeof READY_FOR_SOLVERS_KEYS)[number]>): boolean => computeDrawingPhase(state) === "ready_for_solvers" && hasConstraints(state.polytope);

/** An unbounded region recedes along `direction`, so maximizing it has no optimum. */
export const isUnboundedDirection = (state: Pick<EditorState, "polytope">, direction: Vec): boolean =>
  hasConstraints(state.polytope) && state.polytope.kind === "unbounded" && isObjectiveDirectionUnbounded(state.polytope.constraints, direction);

/** The LP is unbounded: the objective points along a direction the region recedes in. */
export const hasUnboundedObjectiveDirection = (state: Pick<EditorState, "polytope" | "objectiveVector">): boolean =>
  state.objectiveVector !== null && isUnboundedDirection(state, state.objectiveVector);

/**
 * Whether `mode` can run on the problem: every solver needs feasible points, and the central path
 * additionally needs an optimum to walk towards.
 */
export const isSolverSelectable = (state: Pick<EditorState, "polytope" | "objectiveVector">, mode: SolverMode): boolean =>
  hasFeasibleRegion(state) && !(mode === "central" && hasUnboundedObjectiveDirection(state));

// What the draggable start marker means to each solver: nothing (it finds its own start), any
// point, or the region vertex nearest the point (a simplex iterate is a vertex). Dual simplex has
// no safe start-point interpretation: a primal point only determines a dual-feasible basis when it
// is already optimal.
const START_POINT: Record<SolverMode, (settings: SolverSettings) => "none" | "free" | "vertex"> = {
  central: () => "none",
  ellipsoid: () => "none",
  ipm: () => "free",
  pdhg: () => "free",
  simplex: (settings) => (settings.simplexDualMode ? "none" : "vertex"),
};

/**
 * The start the solver would use: the dragged point (snapped to the nearest region vertex when the
 * solver walks vertices), or the solver default when nothing has been dragged yet. The default is
 * the origin for all three: IPM and PDHG begin there, and Phase-1 simplex's first displayed
 * iterate is the origin too (all structural variables start nonbasic). Null when the solver finds
 * its own start or the problem is not solvable, which is when the marker is hidden.
 */
export function displayedSolverStartPoint(state: EditorState & SolverState): Vec | null {
  if (!isReadyForSolvers(state) || !hasFeasibleRegion(state)) return null;
  const meaning = START_POINT[state.solverMode](state.solverSettings);
  if (meaning === "none") return null;
  const point = state.solverStartPoint;
  if (!point) return zeroVec(state.dimension);
  return meaning === "vertex" ? (nearestPolytopeVertex(state, point) ?? point) : point;
}
