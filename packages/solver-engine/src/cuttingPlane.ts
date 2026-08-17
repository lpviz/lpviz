import { linesToDenseAb } from "@lpviz/math/blas";
import { chebyshevCenter, solveSmallLp, type LpRow } from "@lpviz/math/lp";
import type { Lines, VecN, Vertices } from "@lpviz/math/types";
import {
  ELLIPSOID_STRIDE,
  appendIncumbent,
  clipPolygon,
  mostViolatedConstraint,
  objectiveRayStep,
  packPolygons,
  regionBoundingBox,
  type EllipsoidResultData,
  type EllipsoidRow,
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
  // The ellipse drawn for this iterate. Note it is *inscribed* at the query
  // point, where the ellipsoid method's is a covering ellipsoid — the two look
  // alike and mean opposite things. In particular the next query point is
  // routinely outside this ellipse, which is expected: it is a local measure of
  // how much room surrounds the query point, not the region still under
  // consideration. That region is the polyhedron of accumulated cuts, which
  // only ever shrinks (see the test of the same name).
  p11: number;
  p12: number;
  p22: number;
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
 */
export function cuttingPlane(
  vertices: Vertices,
  lines: Lines,
  objective: VecN,
  opts: CuttingPlaneOptions,
): EllipsoidResultData {
  const { maxit, tol, rayShoot, initialScale, queryPoint, verbose } = opts;

  if (maxit > MAX_ITERATIONS_LIMIT) {
    throw new Error(`maxit > ${MAX_ITERATIONS_LIMIT} not allowed`);
  }

  const { A, b } = linesToDenseAb(lines);
  const n = A.cols;
  if (n !== 2) {
    throw new Error(
      "The cutting-plane query points are implemented for two variables.",
    );
  }

  const c = Float64Array.from({ length: n }, (_, j) => objective[j] ?? 0);
  const objectiveNormSquared = c[0]! * c[0]! + c[1]! * c[1]!;
  const { center: boxCenter, halfExtents } = regionBoundingBox(
    vertices,
    n,
    initialScale,
  );

  // the initial localizing set: the same inflated bounding box the ellipsoid
  // method circumscribes, kept as a box here
  const minX = boxCenter[0]! - halfExtents[0]!;
  const maxX = boxCenter[0]! + halfExtents[0]!;
  const minY = boxCenter[1]! - halfExtents[1]!;
  const maxY = boxCenter[1]! + halfExtents[1]!;
  const localizing: number[][] = [
    [1, 0, maxX],
    [-1, 0, -minX],
    [0, 1, maxY],
    [0, -1, -minY],
  ];
  const boxRowCount = localizing.length;
  const boxPolygon = [minX, minY, maxX, minY, maxX, maxY, minX, maxY];
  const polygons: number[][] = [];

  const iterations: Float64Array[] = [];
  const rows: EllipsoidRow[] = [];
  const rho: number[] = [];
  // one slot spare for the incumbent appended at the end
  const ellipsoids = new Float64Array((maxit + 1) * ELLIPSOID_STRIDE);

  const best = new Float64Array(n);
  let bestObjective = -Infinity;
  let upperBound = Infinity;
  let termination: Termination = "maxit";
  const startTime = performance.now();

  const header = " Iter        x        y        Obj     Infeas          ρ";
  if (verbose) console.log(header);

  while (iterations.length < maxit) {
    const query = computeQueryPoint(queryPoint, localizing);
    if (!query) {
      termination = "exhausted";
      break;
    }
    const point = query.point;

    if (queryPoint === "volumetric" && query.leverage) {
      dropRedundantCuts(localizing, boxRowCount, query.leverage);
    }

    const objectiveValue = c[0]! * point[0]! + c[1]! * point[1]!;
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
    const bound = solveSmallLp([c[0]!, c[1]!], localizing, LP_BOUND);
    if (bound.status === "infeasible") {
      termination = "exhausted";
      break;
    }
    upperBound = bound.value;
    const objectiveRadius = Math.max(0, bound.value - objectiveValue);

    // the localizing set as it stood when this point was queried: the box, cut
    // by everything learned so far
    let polygon = boxPolygon;
    for (let i = boxRowCount; i < localizing.length; i++) {
      const cut = localizing[i]!;
      polygon = clipPolygon(polygon, cut[0]!, cut[1]!, cut[2]!);
      if (polygon.length === 0) break;
    }
    polygons.push(polygon === boxPolygon ? [...boxPolygon] : polygon);

    const base = iterations.length * ELLIPSOID_STRIDE;
    ellipsoids[base] = point[0]!;
    ellipsoids[base + 1] = point[1]!;
    ellipsoids[base + 2] = query.p11;
    ellipsoids[base + 3] = query.p12;
    ellipsoids[base + 4] = query.p22;
    const row: EllipsoidRow = {
      kind: "ellipsoid",
      iteration: iterations.length + 1,
      x: point[0]!,
      y: point[1]!,
      objective: objectiveValue,
      infeasibility: Math.max(0, violation),
      rho: objectiveRadius,
    };
    if (verbose) console.log(row);
    rows.push(row);
    rho.push(objectiveRadius);
    iterations.push(Float64Array.of(point[0]!, point[1]!));

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
      localizing.push([
        A.data[worstRow * n]!,
        A.data[worstRow * n + 1]!,
        b[worstRow]!,
      ]);
    } else {
      // discard everything no better than the incumbent
      localizing.push([-c[0]!, -c[1]!, -bestObjective]);
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
    ellipsoids: ellipsoids.slice(0, iterations.length * ELLIPSOID_STRIDE),
    ...packPolygons(polygons),
    rho,
    header,
    rows,
    footer,
  };
}

function computeQueryPoint(
  kind: QueryPoint,
  rows: LpRow[],
): QueryResult | null {
  const ball = chebyshevCenter(rows, 2, LP_BOUND);
  if (!ball || !(ball.radius > MIN_CHEBYSHEV_RADIUS)) return null;
  if (!Number.isFinite(ball.center[0]!) || !Number.isFinite(ball.center[1]!)) {
    return null;
  }

  if (kind === "chebyshev") {
    const radiusSquared = ball.radius * ball.radius;
    return {
      point: ball.center,
      p11: radiusSquared,
      p12: 0,
      p22: radiusSquared,
      leverage: null,
    };
  }

  // the inscribed ball's center is strictly interior, which is exactly what
  // both barriers need to start from — no cut-restoration step required
  const center =
    kind === "analytic"
      ? analyticCenter(rows, ball.center)
      : volumetricCenter(rows, ball.center);
  if (!center) return null;

  const hessian = barrierHessian(rows, center, kind === "volumetric");
  if (!hessian) return null;
  const inverse = invertSymmetric2(hessian.h11, hessian.h12, hessian.h22);
  if (!inverse) return null;

  return {
    point: center,
    p11: inverse.a11,
    p12: inverse.a12,
    p22: inverse.a22,
    leverage: hessian.leverage,
  };
}

function slacksOf(rows: LpRow[], x: Float64Array): Float64Array | null {
  const slacks = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const slack = row[2]! - row[0]! * x[0]! - row[1]! * x[1]!;
    if (!(slack > MIN_SLACK)) return null;
    slacks[i] = slack;
  }
  return slacks;
}

// -sum log(slack), the analytic center's objective
function logBarrier(rows: LpRow[], x: Float64Array): number {
  const slacks = slacksOf(rows, x);
  if (!slacks) return Infinity;
  let value = 0;
  for (let i = 0; i < slacks.length; i++) value -= Math.log(slacks[i]!);
  return value;
}

// ½ log det H(x), Vaidya's volumetric barrier
function volumetricBarrier(rows: LpRow[], x: Float64Array): number {
  const slacks = slacksOf(rows, x);
  if (!slacks) return Infinity;
  let h11 = 0;
  let h12 = 0;
  let h22 = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const inverseSquare = 1 / (slacks[i]! * slacks[i]!);
    h11 += row[0]! * row[0]! * inverseSquare;
    h12 += row[0]! * row[1]! * inverseSquare;
    h22 += row[1]! * row[1]! * inverseSquare;
  }
  const determinant = h11 * h22 - h12 * h12;
  return determinant > 0 ? 0.5 * Math.log(determinant) : Infinity;
}

// H(x) = sum a_i a_i' / s_i^2, plus (for Vaidya) each face's leverage score
// sigma_i = a_i' H^-1 a_i / s_i^2 and the leverage-weighted matrix Q that
// stands in for the volumetric barrier's Hessian.
function barrierHessian(rows: LpRow[], x: Float64Array, weighted: boolean) {
  const slacks = slacksOf(rows, x);
  if (!slacks) return null;

  let h11 = 0;
  let h12 = 0;
  let h22 = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const inverseSquare = 1 / (slacks[i]! * slacks[i]!);
    h11 += row[0]! * row[0]! * inverseSquare;
    h12 += row[0]! * row[1]! * inverseSquare;
    h22 += row[1]! * row[1]! * inverseSquare;
  }
  const inverse = invertSymmetric2(h11, h12, h22);
  if (!inverse) return null;

  const leverage = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const quadratic =
      inverse.a11 * row[0]! * row[0]! +
      2 * inverse.a12 * row[0]! * row[1]! +
      inverse.a22 * row[1]! * row[1]!;
    leverage[i] = quadratic / (slacks[i]! * slacks[i]!);
  }
  if (!weighted) return { h11, h12, h22, leverage, slacks };

  let q11 = 0;
  let q12 = 0;
  let q22 = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const weight = leverage[i]! / (slacks[i]! * slacks[i]!);
    q11 += row[0]! * row[0]! * weight;
    q12 += row[0]! * row[1]! * weight;
    q22 += row[1]! * row[1]! * weight;
  }
  return { h11: q11, h12: q12, h22: q22, leverage, slacks };
}

function invertSymmetric2(a11: number, a12: number, a22: number) {
  const determinant = a11 * a22 - a12 * a12;
  if (!(determinant > 0) || !Number.isFinite(determinant)) return null;
  return {
    a11: a22 / determinant,
    a12: -a12 / determinant,
    a22: a11 / determinant,
  };
}

// Damped Newton on a self-concordant barrier: full steps once the Newton
// decrement is small, backtracking before that (and always far enough to stay
// strictly inside, which the barrier's +Infinity outside enforces on its own).
function minimizeBarrier(
  start: Float64Array,
  gradientAndStep: (
    x: Float64Array,
  ) => { g0: number; g1: number; d0: number; d1: number } | null,
  value: (x: Float64Array) => number,
): Float64Array | null {
  const x = start.slice();
  const candidate = new Float64Array(2);
  let current = value(x);
  if (!Number.isFinite(current)) return null;

  for (let step = 0; step < MAX_NEWTON_STEPS; step++) {
    const direction = gradientAndStep(x);
    if (!direction) return null;
    const decrementSquared = -(
      direction.g0 * direction.d0 +
      direction.g1 * direction.d1
    );
    if (!(decrementSquared > NEWTON_DECREMENT_TOLERANCE)) break;
    const decrement = Math.sqrt(decrementSquared);

    let t =
      decrement > DAMPED_NEWTON_THRESHOLD ? 1 / (1 + decrement) : 1;
    let accepted = false;
    for (let attempt = 0; attempt < MAX_BACKTRACKS; attempt++) {
      candidate[0] = x[0]! + t * direction.d0;
      candidate[1] = x[1]! + t * direction.d1;
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

function analyticCenter(rows: LpRow[], start: Float64Array) {
  return minimizeBarrier(
    start,
    (x) => {
      const hessian = barrierHessian(rows, x, false);
      if (!hessian) return null;
      const inverse = invertSymmetric2(hessian.h11, hessian.h12, hessian.h22);
      if (!inverse) return null;
      let g0 = 0;
      let g1 = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const inverseSlack = 1 / hessian.slacks[i]!;
        g0 += row[0]! * inverseSlack;
        g1 += row[1]! * inverseSlack;
      }
      return {
        g0,
        g1,
        d0: -(inverse.a11 * g0 + inverse.a12 * g1),
        d1: -(inverse.a12 * g0 + inverse.a22 * g1),
      };
    },
    (x) => logBarrier(rows, x),
  );
}

function volumetricCenter(rows: LpRow[], start: Float64Array) {
  return minimizeBarrier(
    start,
    (x) => {
      const weighted = barrierHessian(rows, x, true);
      if (!weighted) return null;
      const inverse = invertSymmetric2(
        weighted.h11,
        weighted.h12,
        weighted.h22,
      );
      if (!inverse) return null;
      // grad ½logdet H = sum sigma_i a_i / s_i
      let g0 = 0;
      let g1 = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const weight = weighted.leverage[i]! / weighted.slacks[i]!;
        g0 += row[0]! * weight;
        g1 += row[1]! * weight;
      }
      return {
        g0,
        g1,
        d0: -(inverse.a11 * g0 + inverse.a12 * g1),
        d1: -(inverse.a12 * g0 + inverse.a22 * g1),
      };
    },
    (x) => volumetricBarrier(rows, x),
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
