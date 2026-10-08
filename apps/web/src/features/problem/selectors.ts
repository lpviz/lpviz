import type { EditorState } from "@/features/polytope-editor/editorState";
import { computeDrawingPhase } from "@/features/polytope-editor/editorState";
import type { SolverMode } from "@/features/solver/solverState";
import type { Vec } from "@lpviz/math/types";
import { isObjectiveDirectionUnbounded } from "@lpviz/polytope/halfSpaces";
import { hasConstraints } from "@lpviz/polytope/polytope";

// What the UI and the solver pipeline need to know about the problem, derived in one place from the
// editor's fields: whether there is a region, whether it has feasible points, whether the objective
// is set, and whether a solve can run. Every panel and request builder reads these instead of
// re-deriving them from `polytope` and `objectiveVector`.

/** The drawing has been derived into a constraint system. */
export const hasRegion = (state: Pick<EditorState, "polytope">): boolean => hasConstraints(state.polytope);

/** The region exists and has feasible points, bounded or not. */
export const hasFeasibleRegion = (state: Pick<EditorState, "polytope">): boolean => hasConstraints(state.polytope) && (state.polytope.kind === "bounded" || state.polytope.kind === "unbounded");

/** The region exists but its constraints admit no point. */
export const isEmptyRegion = (state: Pick<EditorState, "polytope">): boolean => hasConstraints(state.polytope) && state.polytope.kind === "empty";

export const hasObjective = (state: Pick<EditorState, "objectiveVector">): boolean => state.objectiveVector !== null;

/** The drawing is finished, derived, and has an objective: everything a solve needs. */
export const isReadyForSolvers = (state: EditorState): boolean => computeDrawingPhase(state) === "ready_for_solvers" && hasConstraints(state.polytope) && state.objectiveVector !== null;

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
