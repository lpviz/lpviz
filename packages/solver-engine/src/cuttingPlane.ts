import { type DenseMatrix, denseFromConstraints, dot, quadraticForm as denseQuadraticForm } from "@lpviz/math/blas";
import { cholesky, invertFromCholesky, logDetFromCholesky } from "@lpviz/math/lapack";
import { chebyshevCenter, solveSmallLp, type LpRow } from "@lpviz/math/lp";
import type { Constraint, Vec } from "@lpviz/math/types";
import { assertMaxit } from "./limits";
import { FEASIBILITY_TOLERANCE, Incumbent, LocalizationTrace, localizationFooter, localizationLogHeader, mostViolatedConstraint, regionBoundingBox, type Termination } from "./localization";
import type { SolverResult } from "./result";

const MAX_NEWTON_STEPS = 80;
const NEWTON_DECREMENT_TOLERANCE = 1e-12;
const DAMPED_NEWTON_THRESHOLD = 0.25;
const MIN_SLACK = 1e-14;
const BACKTRACK_FACTOR = 0.5;
const MAX_BACKTRACKS = 60;
// Below this the localizing set has no room left to query and the incumbent is
// the answer; it is the polyhedral counterpart of the ellipsoid collapsing.
const MIN_CHEBYSHEV_RADIUS = 1e-12;
// Vaidya drops a cut once its leverage score falls below this, which bounds the constraint
// count; dropping only ever enlarges the localizing set, so it can never lose the optimum.
const VAIDYA_DROP_LEVERAGE = 1e-3;
// inert box for the LP solver: the localizing set carries its own bounds
const LP_BOUND = 1e6;
// A recession direction has to improve the objective by more than this per
// unit length to count: below it the direction runs along an optimal face, not
// away from it, and the optimum it leads to is a finite value.
const RECESSION_TOLERANCE = 1e-9;

export const QUERY_POINTS = ["chebyshev", "analytic", "volumetric"] as const;
export type QueryPoint = (typeof QUERY_POINTS)[number];

export interface CuttingPlaneOptions {
  maxit: number;
  tol: number;
  rayShoot: boolean;
  initialScale: number;
  queryPoint: QueryPoint;
}

type QueryResult = {
  point: Float64Array;
  // The ellipsoid drawn for this iterate as its n x n shape matrix, *inscribed* at the query point
  // (the ellipsoid method's is a covering ellipsoid): a local measure of room, not the region still
  // under consideration, so the next query point is routinely outside it.
  P: Float64Array;
  leverage: Float64Array | null;
};

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
  const { maxit, tol, rayShoot, initialScale, queryPoint } = opts;

  assertMaxit(maxit);

  const { A, b } = denseFromConstraints(constraints);
  const n = A.cols;
  if (n < 2) {
    throw new Error("The cutting-plane query points require at least two variables.");
  }

  const c = Float64Array.from({ length: n }, (_, j) => objective[j] ?? 0);
  const { center: boxCenter, halfExtents } = regionBoundingBox(vertices, n, initialScale);

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
  const trace = new LocalizationTrace(maxit, n, true);

  const incumbent = new Incumbent(A, b, c, rayShoot);
  let upperBound = Infinity;
  let termination: Termination = "maxit";
  const startTime = performance.now();

  while (trace.count < maxit) {
    const query = computeQueryPoint(queryPoint, localizing, n);
    if (!query) {
      termination = "exhausted";
      break;
    }
    const point = query.point;

    if (queryPoint === "volumetric" && query.leverage) {
      dropRedundantCuts(localizing, boxRowCount, query.leverage);
    }

    const objectiveValue = dot(c, point);
    const { row: worstRow, violation } = mostViolatedConstraint(A, b, point);
    const feasible = violation <= FEASIBILITY_TOLERANCE;
    if (feasible) incumbent.offer(point, objectiveValue);

    // rho keeps the meaning it has for the ellipsoid method: how much better
    // than the query point anything still under consideration could be
    const bound = solveSmallLp(Array.from(c), localizing, LP_BOUND);
    if (bound.status === "infeasible") {
      termination = "exhausted";
      break;
    }
    upperBound = bound.value;
    const objectiveRadius = Math.max(0, bound.value - objectiveValue);

    // the localizing set as it stood when this point was queried: the box, cut
    // by everything learned so far
    const drawn = boxPolygon ? clippedBox(boxPolygon, localizing, boxRowCount) : localizing.flat();
    trace.recordIterate(point, query.P, objectiveValue, Math.max(0, violation), objectiveRadius, drawn);

    if (feasible && incumbent.certifies(upperBound, tol)) {
      termination = "converged";
      break;
    }

    const cut = new Array<number>(n + 1);
    if (!feasible) {
      // the violated constraint itself, which is as deep a cut as the oracle
      // can return
      for (let j = 0; j < n; j++) cut[j] = A.data[worstRow * n + j]!;
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
  if ((termination === "converged" || termination === "exhausted") && incumbent.found && objectiveIsUnbounded(A, c)) {
    termination = "unbounded";
  }

  const footer = localizationFooter(termination, trace.count, performance.now() - startTime, {
    exhausted: incumbent.found ? ["Localizing set exhausted", "Nothing better than the incumbent remains, so it is optimal"] : ["No feasible point inside the initial box"],
    unbounded: ["Stopped on the initial box boundary", "The objective is unbounded over this region: the method only searches inside the initial box"],
  });
  trace.closeOnIncumbent(incumbent, upperBound);
  return trace.result(localizationLogHeader(n), footer);
}

// The box polygon clipped by every cut learned so far (the box's own rows are the polygon already).
function clippedBox(boxPolygon: number[], localizing: number[][], boxRowCount: number): number[] {
  let polygon = boxPolygon;
  for (let i = boxRowCount; i < localizing.length; i++) {
    const cut = localizing[i]!;
    polygon = clipPolygon(polygon, cut[0]!, cut[1]!, cut[2]!);
    if (polygon.length === 0) break;
  }
  return polygon === boxPolygon ? [...boxPolygon] : polygon;
}

// Sutherland-Hodgman clip of a convex polygon against `a'x <= b`.
function clipPolygon(polygon: readonly number[], a0: number, a1: number, b: number): number[] {
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

function computeQueryPoint(kind: QueryPoint, rows: LpRow[], n: number): QueryResult | null {
  const ball = chebyshevCenter(rows, n, LP_BOUND);
  if (!ball || !(ball.radius > MIN_CHEBYSHEV_RADIUS)) return null;
  if (!ball.center.every(Number.isFinite)) {
    return null;
  }

  if (kind === "chebyshev") {
    const P = new Float64Array(n * n);
    for (let j = 0; j < n; j++) P[j * n + j] = ball.radius * ball.radius;
    return { point: ball.center, P, leverage: null };
  }

  // the inscribed ball's center is strictly interior, which is exactly what
  // both barriers need to start from — no cut-restoration step required
  const center = barrierCenter(rows, ball.center, kind === "volumetric", n);
  if (!center) return null;

  const hessian = barrierHessian(rows, center, kind === "volumetric", n);
  if (!hessian) return null;
  const P = invertSymmetric(hessian.H, n);
  if (!P) return null;

  return { point: center, P, leverage: hessian.leverage };
}

function slacksOf(rows: LpRow[], x: Float64Array, n: number): Float64Array | null {
  const slacks = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let slack = row[n]!;
    for (let j = 0; j < n; j++) slack -= row[j]! * x[j]!;
    if (!(slack > MIN_SLACK)) return null;
    slacks[i] = slack;
  }
  return slacks;
}

// -sum log(slack), the analytic center's objective
function logBarrier(rows: LpRow[], x: Float64Array, n: number): number {
  const slacks = slacksOf(rows, x, n);
  if (!slacks) return Infinity;
  let value = 0;
  for (let i = 0; i < slacks.length; i++) value -= Math.log(slacks[i]!);
  return value;
}

// sum_i w_i a_i a_i' as a dense symmetric n x n matrix
function weightedGram(rows: LpRow[], weight: (i: number) => number, n: number): Float64Array {
  const H = new Float64Array(n * n);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const w = weight(i);
    for (let j = 0; j < n; j++) {
      for (let k = j; k < n; k++) H[j * n + k] = H[j * n + k]! + row[j]! * row[k]! * w;
    }
  }
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < j; k++) H[j * n + k] = H[k * n + j]!;
  }
  return H;
}

// H(x) = sum a_i a_i' / s_i^2
const barrierGram = (rows: LpRow[], slacks: Float64Array, n: number) => weightedGram(rows, (i) => 1 / (slacks[i]! * slacks[i]!), n);

// ½ log det H(x), Vaidya's volumetric barrier
function volumetricBarrier(rows: LpRow[], x: Float64Array, n: number): number {
  const slacks = slacksOf(rows, x, n);
  if (!slacks) return Infinity;
  const logDet = logDetSymmetric(barrierGram(rows, slacks, n), n);
  return logDet === null ? Infinity : 0.5 * logDet;
}

// H(x), plus (for Vaidya) each face's leverage score
// sigma_i = a_i' H^-1 a_i / s_i^2 and the leverage-weighted matrix Q that
// stands in for the volumetric barrier's Hessian.
function barrierHessian(rows: LpRow[], x: Float64Array, weighted: boolean, n: number) {
  const slacks = slacksOf(rows, x, n);
  if (!slacks) return null;

  const H = barrierGram(rows, slacks, n);
  const inverse = invertSymmetric(H, n);
  if (!inverse) return null;

  const leverage = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    leverage[i] = quadraticForm(inverse, rows[i]!, n) / (slacks[i]! * slacks[i]!);
  }
  if (!weighted) return { H, leverage, slacks };
  return { H: weightedGram(rows, (i) => leverage[i]! / (slacks[i]! * slacks[i]!), n), leverage, slacks };
}

// a' M a for symmetric M; the two-variable form is kept verbatim so those results stay bit-identical
function quadraticForm(M: Float64Array, a: LpRow, n: number): number {
  if (n === 2) {
    return M[0]! * a[0]! * a[0]! + 2 * M[1]! * a[0]! * a[1]! + M[3]! * a[1]! * a[1]!;
  }
  return denseQuadraticForm(M, a, n);
}

// log det H for symmetric positive definite H, or null otherwise.
function logDetSymmetric(H: Float64Array, n: number): number | null {
  if (n === 2) {
    const determinant = H[0]! * H[3]! - H[1]! * H[1]!;
    return determinant > 0 ? Math.log(determinant) : null;
  }
  const L = cholesky(H, n);
  return L && logDetFromCholesky(L, n);
}

// H^-1 for symmetric positive definite H, or null otherwise.
function invertSymmetric(H: Float64Array, n: number): Float64Array | null {
  if (n === 2) {
    const a11 = H[0]!;
    const a12 = H[1]!;
    const a22 = H[3]!;
    const determinant = a11 * a22 - a12 * a12;
    if (!(determinant > 0) || !Number.isFinite(determinant)) return null;
    return Float64Array.of(a22 / determinant, -a12 / determinant, -a12 / determinant, a11 / determinant);
  }
  const L = cholesky(H, n);
  if (!L) return null;
  const inverse = invertFromCholesky(L, n);
  return inverse.every(Number.isFinite) ? inverse : null;
}

// Damped Newton on a self-concordant barrier: full steps once the Newton
// decrement is small, backtracking before that (and always far enough to stay
// strictly inside, which the barrier's +Infinity outside enforces on its own).
function minimizeBarrier(
  start: Float64Array,
  n: number,
  gradientAndStep: (x: Float64Array) => { gradient: Float64Array; direction: Float64Array } | null,
  value: (x: Float64Array) => number,
): Float64Array | null {
  const x = start.slice();
  const candidate = new Float64Array(n);
  let current = value(x);
  if (!Number.isFinite(current)) return null;

  for (let step = 0; step < MAX_NEWTON_STEPS; step++) {
    const newton = gradientAndStep(x);
    if (!newton) return null;
    const decrementSquared = -dot(newton.gradient, newton.direction);
    if (!(decrementSquared > NEWTON_DECREMENT_TOLERANCE)) break;
    const decrement = Math.sqrt(decrementSquared);

    let t = decrement > DAMPED_NEWTON_THRESHOLD ? 1 / (1 + decrement) : 1;
    let accepted = false;
    for (let attempt = 0; attempt < MAX_BACKTRACKS; attempt++) {
      for (let j = 0; j < n; j++) candidate[j] = x[j]! + t * newton.direction[j]!;
      const next = value(candidate);
      if (Number.isFinite(next) && next < current) {
        x.set(candidate);
        current = next;
        accepted = true;
        break;
      }
      t *= BACKTRACK_FACTOR;
    }
    if (!accepted) break;
  }
  return x;
}

// The analytic center minimizes the log barrier, whose gradient is
// sum a_i / s_i; the volumetric center minimizes ½ log det H, whose gradient
// weights each face by its leverage score: sum sigma_i a_i / s_i.
function barrierCenter(rows: LpRow[], start: Float64Array, volumetric: boolean, n: number) {
  return minimizeBarrier(
    start,
    n,
    (x) => {
      const hessian = barrierHessian(rows, x, volumetric, n);
      if (!hessian) return null;
      const inverse = invertSymmetric(hessian.H, n);
      if (!inverse) return null;
      const gradient = new Float64Array(n);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const weight = volumetric ? hessian.leverage[i]! / hessian.slacks[i]! : 1 / hessian.slacks[i]!;
        for (let j = 0; j < n; j++) gradient[j] = gradient[j]! + row[j]! * weight;
      }
      // the Newton direction -H^-1 g
      const direction = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let k = 0; k < n; k++) sum += inverse[j * n + k]! * gradient[k]!;
        direction[j] = -sum;
      }
      return { gradient, direction };
    },
    (x) => (volumetric ? volumetricBarrier(rows, x, n) : logBarrier(rows, x, n)),
  );
}

// Never drops the initial box, which is what keeps the localizing set bounded.
function dropRedundantCuts(rows: number[][], boxRowCount: number, leverage: Float64Array): void {
  if (rows.length !== leverage.length) return;
  for (let i = rows.length - 1; i >= boxRowCount; i--) {
    if (leverage[i]! < VAIDYA_DROP_LEVERAGE) rows.splice(i, 1);
  }
}
