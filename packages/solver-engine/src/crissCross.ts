// The criss-cross method (Terlaky's least-index rule) on `max c'x s.t. Ax <= b`: from any basis,
// exchange the first row (in a fixed index order) that breaks primal or dual feasibility with the
// first row that can repair it. No phase 1 and no ratio test, so the walk crosses the region's
// boundary freely; the index rule alone makes it finite. The basis walk is vertexBasis.ts.

import type { Constraint } from "@lpviz/math/types";
import { warmStart } from "./limits";
import type { SolverResult } from "./result";
import { type IndexOrder, leastIndexPivot, vertexLp, walkVertexBases } from "./vertexBasis";

export { defaultStartVertex, INDEX_ORDERS, type IndexOrder } from "./vertexBasis";

export interface CrissCrossOptions {
  tol: number;
  /** the cap on bases visited */
  maxit: number;
  /** the order the rule ranks rows in; "first" (lowest index first) when absent */
  order?: IndexOrder | undefined;
  /** a vertex whose tight rows are the first basis; the first independent rows when absent or not a vertex */
  startVertex?: readonly number[] | undefined;
}

/** Criss-cross on `max objective'x s.t. Ax <= b`, from the start vertex's basis or the first independent rows. */
export function crissCross(constraints: readonly Constraint[], objective: Float64Array, { tol, maxit, order = "first", startVertex }: CrissCrossOptions): SolverResult {
  const { lp, start } = vertexLp(constraints, objective, { tol, order: order === "last" ? "last" : "first", startVertex: warmStart(startVertex, objective.length), name: "Criss-cross" });
  return walkVertexBases(
    lp,
    start,
    maxit,
    (state) => leastIndexPivot(lp, state),
    (pivots, status) => {
      const count = `${pivots} pivot${pivots === 1 ? "" : "s"}`;
      return status === "optimal" ? `Optimal basis after ${count}` : status === "stopped" ? `Did not converge: stopped at the cap after ${count}` : `Stopped after ${count}`;
    },
  );
}
