import { linesToDenseAb } from "@lpviz/math/blas";
import { solveDenseSystem } from "@lpviz/math/lapack";
import { chebyshevCenter, solveSmallLp, type LpRow } from "@lpviz/math/lp";
import type { LinesND, VecN } from "@lpviz/math/types";
import {
  appendIncumbent,
  clipPolygon,
  ellipsoidLogHeader,
  ellipsoidRow,
  ellipsoidStride,
  mostViolatedConstraint,
  objectiveRayStep,
  packPolygons,
  regionBoundingBox,
  writeEllipsoid,
  type EllipsoidResultData,
  type EllipsoidRow,
  type RegionVertices,
} from "./ellipsoid";
import { formatMilliseconds } from "./time";

const MAX_ITERATIONS_LIMIT = 100_000;
const FEASIBILITY_TOLERANCE = 1e-9;
const MAX_NEWTON_STEPS = 80;
const NEWTON_DECREMENT_TOLERANCE = 1e-12;
const DAMPED_NEWTON_THRESHOLD = 0.25;
const MIN_SLACK = 1e-14;
const BACKTRACK_FACTOR = 0.5;
const MAX_BACKTRACKS = 60;
// Below this the localizing set has no room left to query and the incumbent is
// the answer; it is the polyhedral counterpart of the ellipsoid collapsing.
const MIN_CHEBYSHEV_RADIUS = 1e-12;
// Vaidya drops a cut once its leverage score falls below a threshold — those
// cuts are nearly redundant, and dropping them is what keeps the constraint
// count (and so the per-iteration cost) bounded. Dropping only ever enlarges
// the localizing set, so it can never lose the optimum.
const VAIDYA_DROP_LEVERAGE = 1e-3;
// inert box for the LP solver: the localizing set carries its own bounds
const LP_BOUND = 1e6;

export type QueryPoint = "analytic" | "chebyshev" | "volumetric";

export interface CuttingPlaneOptions {
  maxit: number;
  tol: number;
  rayShoot: boolean;
  initialScale: number;
  queryPoint: QueryPoint;
  verbose: boolean;
}

type Termination = "converged" | "maxit" | "exhausted" | "degenerate";

type QueryResult = {
  point: Float64Array;
  // The ellipsoid drawn for this iterate, as its n x n shape matrix. Note it is
  // *inscribed* at the query point, where the ellipsoid method's is a covering
  // ellipsoid — the two look alike and mean opposite things. In particular the
  // next query point is routinely outside this ellipsoid, which is expected: it
  // is a local measure of how much room surrounds the query point, not the
  // region still under consideration. That region is the polyhedron of
  // accumulated cuts, which only ever shrinks (see the test of the same name).
  P: Float64Array;
  leverage: Float64Array | null;
};

/**
 * Cutting-plane methods that localize with a polyhedron instead of an
 * ellipsoid, differing only in which point of it they query next:
 *
 *   - `chebyshev`  the center of its largest inscribed ball (one LP);
 *   - `analytic`   the minimizer of the log barrier -sum log(b_i - a_i'x),
 *                  i.e. the point furthest from all faces in the barrier's
 *                  sense (ACCPM);
 *   - `volumetric` Vaidya's minimizer of ½ log det H(x), which weights each
 *                  face by its leverage score so that near-redundant cuts stop
 *                  dragging the query point around, plus cut dropping.
 *
 * They exist here because the ellipsoid method's spiral comes from querying the
 * *center of a covering ellipsoid*, which is a crude proxy for "deep inside the
 * region still under consideration". These query points are the principled
 * answer, and they do not precess.
 *
 * The oracle, the incumbent handling and the ray shoot are shared with the
 * ellipsoid method, so iteration counts are directly comparable: all of them
 * start from the same inflated bounding box of the drawn region, and all of
 * them learn constraints only when a query point violates one.
 *
 * Unlike the ellipsoid method, the localizing set here is a polyhedron whose
 * support function is not available in closed form, so the upper bound
 * `max c'x over L` that drives `rho` and the stopping gap is an actual LP,
 * solved exactly each iteration.
 *
 * Everything is written for n variables (the app uses 2 and 3): the barriers'
 * Hessians are n x n, the Newton directions come from a dense solve, and the
 * localizing set is emitted as a polygon for n = 2 and as its half-spaces for
 * n = 3, where the viewport enumerates the polyhedron itself.
 */
export function cuttingPlane(
  vertices: RegionVertices,
  lines: LinesND,
  objective: VecN,
  opts: CuttingPlaneOptions,
): EllipsoidResultData {
  const { maxit, tol, rayShoot, initialScale, queryPoint, verbose } = opts;

  if (maxit > MAX_ITERATIONS_LIMIT) {
    throw new Error(`maxit > ${MAX_ITERATIONS_LIMIT} not allowed`);
  }

  const { A, b } = linesToDenseAb(lines);
  const n = A.cols;
  if (n < 2) {
    throw new Error(
      "The cutting-plane query points require at least two variables.",
    );
  }

  const c = Float64Array.from({ length: n }, (_, j) => objective[j] ?? 0);
  const objectiveNormSquared = dot(c, c);
  const { center: boxCenter, halfExtents } = regionBoundingBox(
    vertices,
    n,
    initialScale,
  );

  // the initial localizing set: the same inflated bounding box the ellipsoid
  // method circumscribes, kept as a box here — two half-spaces per axis
  const localizing: number[][] = [];
  for (let j = 0; j < n; j++) {
    const lo = boxCenter[j]! - halfExtents[j]!;
    const hi = boxCenter[j]! + halfExtents[j]!;
    const upper = new Array<number>(n + 1).fill(0);
    upper[j] = 1;
    upper[n] = hi;
    const lower = new Array<number>(n + 1).fill(0);
    lower[j] = -1;
    lower[n] = -lo;
    localizing.push(upper, lower);
  }
  const boxRowCount = localizing.length;
  // In 2D the drawn localizing set is the clipped box polygon; in higher
  // dimensions it is the half-space list itself (see EllipsoidResultData).
  const boxPolygon =
    n === 2
      ? [
          localizing[1]![2]! * -1,
          localizing[3]![2]! * -1,
          localizing[0]![2]!,
          localizing[3]![2]! * -1,
          localizing[0]![2]!,
          localizing[2]![2]!,
          localizing[1]![2]! * -1,
          localizing[2]![2]!,
        ]
      : null;
  const polygonStride = boxPolygon ? 2 : n + 1;
  const polygons: number[][] = [];

  const iterations: Float64Array[] = [];
  const rows: EllipsoidRow[] = [];
  const rho: number[] = [];
  const stride = ellipsoidStride(n);
  // one slot spare for the incumbent appended at the end
  const ellipsoids = new Float64Array((maxit + 1) * stride);

  const best = new Float64Array(n);
  let bestObjective = -Infinity;
  let upperBound = Infinity;
  let termination: Termination = "maxit";
  const startTime = performance.now();

  const header = ellipsoidLogHeader(n);
  if (verbose) console.log(header);

  while (iterations.length < maxit) {
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
    if (feasible && objectiveValue > bestObjective) {
      bestObjective = objectiveValue;
      best.set(point);
    }
    if (feasible && rayShoot) {
      const step = objectiveRayStep(A, b, point, c, n);
      const shotObjective = objectiveValue + step * objectiveNormSquared;
      if (shotObjective > bestObjective) {
        bestObjective = shotObjective;
        for (let j = 0; j < n; j++) best[j] = point[j]! + step * c[j]!;
      }
    }

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
    if (boxPolygon) {
      let polygon = boxPolygon;
      for (let i = boxRowCount; i < localizing.length; i++) {
        const cut = localizing[i]!;
        polygon = clipPolygon(polygon, cut[0]!, cut[1]!, cut[2]!);
        if (polygon.length === 0) break;
      }
      polygons.push(polygon === boxPolygon ? [...boxPolygon] : polygon);
    } else {
      polygons.push(localizing.flat());
    }

    writeEllipsoid(ellipsoids, iterations.length * stride, point, query.P, n);
    const row = ellipsoidRow(
      iterations.length + 1,
      point,
      objectiveValue,
      Math.max(0, violation),
      objectiveRadius,
    );
    if (verbose) console.log(row);
    rows.push(row);
    rho.push(objectiveRadius);
    iterations.push(point.slice());

    const gap = bound.value - bestObjective;
    if (
      feasible &&
      bestObjective > -Infinity &&
      gap <= tol * (1 + Math.abs(bestObjective))
    ) {
      termination = "converged";
      break;
    }

    if (!feasible) {
      // the violated constraint itself, which is as deep a cut as the oracle
      // can return
      const cut = new Array<number>(n + 1);
      for (let j = 0; j < n; j++) cut[j] = A.data[worstRow * n + j]!;
      cut[n] = b[worstRow]!;
      localizing.push(cut);
    } else {
      // discard everything no better than the incumbent
      const cut = new Array<number>(n + 1);
      for (let j = 0; j < n; j++) cut[j] = -c[j]!;
      cut[n] = -bestObjective;
      localizing.push(cut);
    }
  }

  const footer = buildFooter(
    termination,
    iterations.length,
    performance.now() - startTime,
    bestObjective,
  );
  if (verbose) console.log(footer);

  appendIncumbent(
    { iterations, rows, rho, ellipsoids, polygons },
    best,
    bestObjective,
    upperBound,
  );

  return {
    iterations,
    ellipsoids: ellipsoids.slice(0, iterations.length * stride),
    ellipsoidStride: stride,
    ...packPolygons(polygons, polygonStride),
    rho,
    header,
    rows,
    footer,
  };
}

function computeQueryPoint(
  kind: QueryPoint,
  rows: LpRow[],
  n: number,
): QueryResult | null {
  const ball = chebyshevCenter(rows, n, LP_BOUND);
  if (!ball || !(ball.radius > MIN_CHEBYSHEV_RADIUS)) return null;
  if (!ball.center.every((value) => Number.isFinite(value))) return null;

  if (kind === "chebyshev") {
    const P = new Float64Array(n * n);
    for (let j = 0; j < n; j++) P[j * n + j] = ball.radius * ball.radius;
    return { point: ball.center, P, leverage: null };
  }

  // the inscribed ball's center is strictly interior, which is exactly what
  // both barriers need to start from — no cut-restoration step required
  const center =
    kind === "analytic"
      ? analyticCenter(rows, ball.center, n)
      : volumetricCenter(rows, ball.center, n);
  if (!center) return null;

  const hessian = barrierHessian(rows, center, kind === "volumetric", n);
  if (!hessian) return null;
  const P = invertPositiveDefinite(hessian.H, n);
  if (!P) return null;

  return { point: center, P, leverage: hessian.leverage };
}

function dot(a: Float64Array, x: Float64Array) {
  let sum = 0;
  for (let j = 0; j < a.length; j++) sum += a[j]! * x[j]!;
  return sum;
}

function slacksOf(
  rows: LpRow[],
  x: Float64Array,
  n: number,
): Float64Array | null {
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

// H(x) = sum a_i a_i' / s_i^2 as a dense symmetric n x n matrix
function accumulateOuter(
  H: Float64Array,
  row: LpRow,
  weight: number,
  n: number,
): void {
  for (let j = 0; j < n; j++) {
    const aj = row[j]! * weight;
    for (let k = 0; k < n; k++) H[j * n + k] += aj * row[k]!;
  }
}

// -sum log(slack), the analytic center's objective
function logBarrier(rows: LpRow[], x: Float64Array, n: number): number {
  const slacks = slacksOf(rows, x, n);
  if (!slacks) return Infinity;
  let value = 0;
  for (let i = 0; i < slacks.length; i++) value -= Math.log(slacks[i]!);
  return value;
}

// ½ log det H(x), Vaidya's volumetric barrier
function volumetricBarrier(rows: LpRow[], x: Float64Array, n: number): number {
  const slacks = slacksOf(rows, x, n);
  if (!slacks) return Infinity;
  const H = new Float64Array(n * n);
  for (let i = 0; i < rows.length; i++) {
    accumulateOuter(H, rows[i]!, 1 / (slacks[i]! * slacks[i]!), n);
  }
  const logDet = logDetPositiveDefinite(H, n);
  return logDet === null ? Infinity : 0.5 * logDet;
}

// H(x) = sum a_i a_i' / s_i^2, plus (for Vaidya) each face's leverage score
// sigma_i = a_i' H^-1 a_i / s_i^2 and the leverage-weighted matrix Q that
// stands in for the volumetric barrier's Hessian.
function barrierHessian(
  rows: LpRow[],
  x: Float64Array,
  weighted: boolean,
  n: number,
) {
  const slacks = slacksOf(rows, x, n);
  if (!slacks) return null;

  const H = new Float64Array(n * n);
  for (let i = 0; i < rows.length; i++) {
    accumulateOuter(H, rows[i]!, 1 / (slacks[i]! * slacks[i]!), n);
  }
  const inverse = invertPositiveDefinite(H, n);
  if (!inverse) return null;

  const leverage = new Float64Array(rows.length);
  const scratch = new Float64Array(n);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    // a_i' H^-1 a_i
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += inverse[j * n + k]! * row[k]!;
      scratch[j] = sum;
    }
    let quadratic = 0;
    for (let j = 0; j < n; j++) quadratic += row[j]! * scratch[j]!;
    leverage[i] = quadratic / (slacks[i]! * slacks[i]!);
  }
  if (!weighted) return { H, leverage, slacks };

  const Q = new Float64Array(n * n);
  for (let i = 0; i < rows.length; i++) {
    accumulateOuter(Q, rows[i]!, leverage[i]! / (slacks[i]! * slacks[i]!), n);
  }
  return { H: Q, leverage, slacks };
}

// Lower Cholesky factor of a symmetric matrix, or null when it is not
// (numerically) positive definite — which is also the positive-definiteness
// test every caller needs before trusting an inverse or a log-determinant.
function cholesky(H: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    let diagonal = H[j * n + j]!;
    for (let k = 0; k < j; k++) diagonal -= L[j * n + k]! * L[j * n + k]!;
    if (!(diagonal > 0) || !Number.isFinite(diagonal)) return null;
    const ljj = Math.sqrt(diagonal);
    L[j * n + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let sum = H[i * n + j]!;
      for (let k = 0; k < j; k++) sum -= L[i * n + k]! * L[j * n + k]!;
      L[i * n + j] = sum / ljj;
    }
  }
  return L;
}

function logDetPositiveDefinite(H: Float64Array, n: number): number | null {
  const L = cholesky(H, n);
  if (!L) return null;
  let logDet = 0;
  for (let j = 0; j < n; j++) logDet += 2 * Math.log(L[j * n + j]!);
  return Number.isFinite(logDet) ? logDet : null;
}

// H^-1 for symmetric positive definite H, column by column.
function invertPositiveDefinite(
  H: Float64Array,
  n: number,
): Float64Array | null {
  if (!cholesky(H, n)) return null;
  const inverse = new Float64Array(n * n);
  const unit = new Float64Array(n);
  const column = new Float64Array(n);
  const lu = new Float64Array(n * n);
  try {
    for (let k = 0; k < n; k++) {
      unit.fill(0);
      unit[k] = 1;
      solveDenseSystem(H, n, unit, column, lu);
      for (let j = 0; j < n; j++) {
        if (!Number.isFinite(column[j]!)) return null;
        inverse[j * n + k] = column[j]!;
      }
    }
  } catch {
    return null;
  }
  return inverse;
}

// Damped Newton on a self-concordant barrier: full steps once the Newton
// decrement is small, backtracking before that (and always far enough to stay
// strictly inside, which the barrier's +Infinity outside enforces on its own).
function minimizeBarrier(
  start: Float64Array,
  n: number,
  gradientAndStep: (
    x: Float64Array,
  ) => { gradient: Float64Array; direction: Float64Array } | null,
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

    let t =
      decrement > DAMPED_NEWTON_THRESHOLD ? 1 / (1 + decrement) : 1;
    let accepted = false;
    for (let attempt = 0; attempt < MAX_BACKTRACKS; attempt++) {
      for (let j = 0; j < n; j++) {
        candidate[j] = x[j]! + t * newton.direction[j]!;
      }
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

// Newton direction d = -H^-1 g, or null when H is not positive definite.
function newtonDirection(
  H: Float64Array,
  gradient: Float64Array,
  n: number,
): Float64Array | null {
  if (!cholesky(H, n)) return null;
  const direction = new Float64Array(n);
  try {
    solveDenseSystem(H, n, gradient, direction);
  } catch {
    return null;
  }
  for (let j = 0; j < n; j++) {
    if (!Number.isFinite(direction[j]!)) return null;
    direction[j] = -direction[j]!;
  }
  return direction;
}

function analyticCenter(rows: LpRow[], start: Float64Array, n: number) {
  return minimizeBarrier(
    start,
    n,
    (x) => {
      const hessian = barrierHessian(rows, x, false, n);
      if (!hessian) return null;
      // grad -sum log s_i = sum a_i / s_i
      const gradient = new Float64Array(n);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const inverseSlack = 1 / hessian.slacks[i]!;
        for (let j = 0; j < n; j++) gradient[j] += row[j]! * inverseSlack;
      }
      const direction = newtonDirection(hessian.H, gradient, n);
      return direction ? { gradient, direction } : null;
    },
    (x) => logBarrier(rows, x, n),
  );
}

function volumetricCenter(rows: LpRow[], start: Float64Array, n: number) {
  return minimizeBarrier(
    start,
    n,
    (x) => {
      const weighted = barrierHessian(rows, x, true, n);
      if (!weighted) return null;
      // grad ½logdet H = sum sigma_i a_i / s_i
      const gradient = new Float64Array(n);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const weight = weighted.leverage[i]! / weighted.slacks[i]!;
        for (let j = 0; j < n; j++) gradient[j] += row[j]! * weight;
      }
      const direction = newtonDirection(weighted.H, gradient, n);
      return direction ? { gradient, direction } : null;
    },
    (x) => volumetricBarrier(rows, x, n),
  );
}

// Never drops the initial box, which is what keeps the localizing set bounded.
function dropRedundantCuts(
  rows: number[][],
  boxRowCount: number,
  leverage: Float64Array,
): void {
  if (rows.length !== leverage.length) return;
  for (let i = rows.length - 1; i >= boxRowCount; i--) {
    if (leverage[i]! < VAIDYA_DROP_LEVERAGE) rows.splice(i, 1);
  }
}

function buildFooter(
  termination: Termination,
  iterationCount: number,
  solveTime: number,
  bestObjective: number,
) {
  const elapsed = formatMilliseconds(solveTime);
  switch (termination) {
    case "converged":
      return `Converged to optimal solution in ${elapsed} / ${iterationCount} iterations\n`;
    case "exhausted":
      return bestObjective === -Infinity
        ? `No feasible point inside the initial box after ${iterationCount} iterations in ${elapsed}\n`
        : `Localizing set exhausted after ${iterationCount} iterations in ${elapsed}\nNothing better than the incumbent remains, so it is optimal\n`;
    case "degenerate":
      return `Query point degenerated numerically after ${iterationCount} iterations in ${elapsed}\n`;
    default:
      return `Did not converge after ${iterationCount} iterations in ${elapsed}\n`;
  }
}
