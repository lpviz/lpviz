import { extractRow } from "@lpviz/math/blas";
import type { DenseMatrix } from "@lpviz/math/blas";
import { type LpRow, solveSmallLp } from "@lpviz/math/lp";
import type { Constraint, Vec } from "@lpviz/math/types";
import { computeQueryPoint, LP_BOUND, type QueryPoint } from "./barrierCenters";
import { LocalizationRun, regionBoundingBox, type LocalizationOptions } from "./localization";
import type { SolverResult } from "./result";

export { QUERY_POINTS, type QueryPoint } from "./barrierCenters";

// Vaidya drops a cut once its leverage score falls below this, which bounds the constraint
// count; dropping only ever enlarges the localizing set, so it can never lose the optimum.
const VAIDYA_DROP_LEVERAGE = 1e-3;
// A recession direction has to improve the objective by more than this per
// unit length to count: below it the direction runs along an optimal face, not
// away from it, and the optimum it leads to is a finite value.
const RECESSION_TOLERANCE = 1e-9;

export interface CuttingPlaneOptions extends LocalizationOptions {
  queryPoint: QueryPoint;
}

/**
 * Cutting-plane methods that localize with a polyhedron instead of an ellipsoid, differing in the
 * point they query next: `chebyshev` the center of the largest inscribed ball (one LP), `analytic`
 * the log-barrier minimizer (ACCPM), `volumetric` Vaidya's minimizer of ½ log det H(x) with
 * leverage-weighted faces plus cut dropping. The oracle, incumbent and ray shoot are shared with
 * the ellipsoid method, so iteration counts are directly comparable. The polyhedron's support
 * function has no closed form, so the upper bound `max c'x over L` behind `rho` and the stopping
 * gap is an actual LP, solved exactly each iteration.
 *
 * Written for n variables: the barriers' Hessians are n x n (two variables keep their closed
 * forms, more go through a Cholesky factorization), and the localizing set is emitted as a polygon
 * for n = 2 and as its half-spaces otherwise.
 */
export function cuttingPlane(vertices: Vec[], constraints: readonly Constraint[], objective: Float64Array, opts: CuttingPlaneOptions): SolverResult {
  const run = new LocalizationRun(constraints, objective, opts, true, "The cutting-plane query points require at least two variables.");
  const { A, b, c, n, trace, incumbent } = run;
  const { center: boxCenter, halfExtents } = regionBoundingBox(vertices, n, opts.initialScale);

  // the initial localizing set: the same inflated bounding box the ellipsoid
  // method circumscribes, kept as a box here, two half-spaces per axis
  const localizing: number[][] = [];
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    lo[j] = boxCenter[j]! - halfExtents[j]!;
    hi[j] = boxCenter[j]! + halfExtents[j]!;
    const upper = new Array<number>(n + 1).fill(0);
    upper[j] = 1;
    upper[n] = hi[j]!;
    const lower = new Array<number>(n + 1).fill(0);
    lower[j] = -1;
    lower[n] = -lo[j]!;
    localizing.push(upper, lower);
  }
  const boxRowCount = localizing.length;
  // the drawn localizing set is the clipped box polygon for two variables and
  // the half-space list itself otherwise (see localizingSetStride)
  const boxPolygon = n === 2 ? [lo[0]!, lo[1]!, hi[0]!, lo[1]!, hi[0]!, hi[1]!, lo[0]!, hi[1]!] : null;
  const objectiveRow = Array.from(c);

  while (trace.count < opts.maxit) {
    const query = computeQueryPoint(opts.queryPoint, localizing, n);
    if (!query) {
      run.termination = "exhausted";
      break;
    }
    const point = query.point;

    if (opts.queryPoint === "volumetric" && query.leverage) {
      dropRedundantCuts(localizing, boxRowCount, query.leverage);
    }

    const { objectiveValue, worstRow, violation, feasible } = run.query(point);

    // rho keeps the meaning it has for the ellipsoid method: how much better
    // than the query point anything still under consideration could be
    const bound = solveSmallLp(objectiveRow, localizing, LP_BOUND);
    if (bound.status === "infeasible") {
      run.termination = "exhausted";
      break;
    }
    run.upperBound = bound.value;
    const objectiveRadius = Math.max(0, bound.value - objectiveValue);

    // the localizing set as it stood when this point was queried: the box, cut
    // by everything learned so far
    const drawn = boxPolygon ? clippedBox(boxPolygon, localizing, boxRowCount) : localizing.flat();
    trace.recordIterate(point, query.P, objectiveValue, Math.max(0, violation), objectiveRadius, drawn);
    if (run.converged(feasible)) break;

    const cut = new Array<number>(n + 1);
    if (!feasible) {
      // the violated constraint itself, which is as deep a cut as the oracle
      // can return
      extractRow(A, worstRow, cut);
      cut[n] = b[worstRow]!;
    } else {
      // discard everything no better than the incumbent
      for (let j = 0; j < n; j++) cut[j] = -c[j]!;
      cut[n] = -incumbent.objective;
    }
    localizing.push(cut);
  }

  // Both of these are claims of optimality, and both are wrong when the
  // objective is unbounded: nothing but the initial box stopped the method.
  if ((run.termination === "converged" || run.termination === "exhausted") && incumbent.found && objectiveIsUnbounded(A, c)) {
    run.termination = "unbounded";
  }

  return run.finish({
    exhausted: incumbent.found ? ["Localizing set exhausted", "Nothing better than the incumbent remains, so it is optimal"] : ["No feasible point inside the initial box"],
    unbounded: ["Stopped on the initial box boundary", "The objective is unbounded over this region: the method only searches inside the initial box"],
  });
}

// The box polygon clipped by every cut learned so far (the box's own rows are the polygon already).
function clippedBox(boxPolygon: number[], localizing: number[][], boxRowCount: number): number[] {
  let polygon = boxPolygon;
  for (let i = boxRowCount; i < localizing.length; i++) {
    const cut = localizing[i]!;
    polygon = clipBoxPolygon(polygon, cut[0]!, cut[1]!, cut[2]!);
    if (polygon.length === 0) break;
  }
  return polygon === boxPolygon ? [...boxPolygon] : polygon;
}

// Sutherland-Hodgman clip of the box polygon against `a'x <= b`. Its own arithmetic, kept apart
// from the math package's clip: the polygon is part of the hashed localizing set.
function clipBoxPolygon(polygon: readonly number[], a0: number, a1: number, b: number): number[] {
  const out: number[] = [];
  const count = polygon.length / 2;
  if (count === 0) return out;
  for (let i = 0; i < count; i++) {
    const x0 = polygon[i * 2]!;
    const y0 = polygon[i * 2 + 1]!;
    const next = (i + 1) % count;
    const x1 = polygon[next * 2]!;
    const y1 = polygon[next * 2 + 1]!;
    const d0 = a0 * x0 + a1 * y0 - b;
    const d1 = a0 * x1 + a1 * y1 - b;
    if (d0 <= 0) out.push(x0, y0);
    if ((d0 < 0 && d1 > 0) || (d0 > 0 && d1 < 0)) {
      const t = d0 / (d0 - d1);
      out.push(x0 + t * (x1 - x0), y0 + t * (y1 - y0));
    }
  }
  return out;
}

/**
 * Whether `max c'x` over `Ax <= b` is unbounded: some recession direction `d` (`Ad <= 0`) has
 * `c'd > 0`, one small LP over the recession cone clipped to the unit box. The ellipsoid method's
 * boundary test does not transfer: the query points here are strictly interior, and a *bounded*
 * objective whose optimal face is a ray also runs into the box, so position cannot tell the two apart.
 */
function objectiveIsUnbounded(A: DenseMatrix, c: Float64Array): boolean {
  const n = A.cols;
  const cone: LpRow[] = [];
  for (let i = 0; i < A.rows; i++) {
    cone.push([...A.data.subarray(i * n, (i + 1) * n), 0]);
  }
  const best = solveSmallLp(Array.from(c), cone, 1);
  return best.status === "optimal" && best.value > RECESSION_TOLERANCE * Math.hypot(...c);
}

// Never drops the initial box, which is what keeps the localizing set bounded.
function dropRedundantCuts(rows: number[][], boxRowCount: number, leverage: Float64Array): void {
  if (rows.length !== leverage.length) return;
  for (let i = rows.length - 1; i >= boxRowCount; i--) {
    if (leverage[i]! < VAIDYA_DROP_LEVERAGE) rows.splice(i, 1);
  }
}
