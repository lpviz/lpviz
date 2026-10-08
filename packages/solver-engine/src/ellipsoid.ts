import { denseFromConstraints, dot, quadraticForm } from "@lpviz/math/blas";
import type { Constraint, Vec } from "@lpviz/math/types";
import { assertMaxit } from "./limits";
import { FEASIBILITY_TOLERANCE, Incumbent, LocalizationTrace, localizationFooter, localizationLogHeader, mostViolatedConstraint, regionBoundingBox, type Termination } from "./localization";
import type { SolverResult } from "./result";

const INITIAL_BOUNDARY_TOLERANCE = 1e-3;

export interface EllipsoidOptions {
  maxit: number;
  tol: number;
  deepCuts: boolean;
  rayShoot: boolean;
  initialScale: number;
}

/**
 * The ellipsoid method on `max objective'x s.t. Ax <= b`, sliding-objective variant: an infeasible
 * center is cut with the most violated row, a feasible one with the objective. Deep cuts push the
 * plane to the constraint / incumbent level; the ray shoot slides a feasible center along the
 * objective to the blocking constraint before adopting it as the incumbent.
 *
 * `rho = sqrt(objective' P objective)` is the ellipsoid's half-width along the objective, so
 * `objective'c + rho` upper-bounds the optimum while the incumbent lower-bounds it; that gap is
 * the stopping measure and the vertical lift of the 3D iterate path.
 */
export function ellipsoid(vertices: Vec[], constraints: readonly Constraint[], objective: Float64Array, opts: EllipsoidOptions): SolverResult {
  const { maxit, tol, deepCuts, rayShoot, initialScale } = opts;

  assertMaxit(maxit);

  const { A, b } = denseFromConstraints(constraints);
  const n = A.cols;
  if (n < 2) {
    throw new Error("The ellipsoid method requires at least two variables.");
  }

  const c = Float64Array.from({ length: n }, (_, j) => objective[j] ?? 0);
  const { center, P } = initialEllipsoid(vertices, n, initialScale);
  const initialCenter = center.slice();
  const initialSemiAxes = Float64Array.from({ length: n }, (_, j) => Math.sqrt(P[j * n + j]!));

  const trace = new LocalizationTrace(maxit, n, false);
  const g = new Float64Array(n);
  const Pg = new Float64Array(n);
  const nextP = new Float64Array(n * n);

  const incumbent = new Incumbent(A, b, c, rayShoot);
  let upperBound = Infinity;
  let termination: Termination = "maxit";
  const startTime = performance.now();

  while (trace.count < maxit) {
    const objectiveValue = dot(c, center);
    const { row: worstRow, violation } = mostViolatedConstraint(A, b, center);
    const feasible = violation <= FEASIBILITY_TOLERANCE;
    if (feasible) incumbent.offer(center, objectiveValue);

    const objectiveRadius = Math.sqrt(Math.max(0, quadraticForm(P, c, n)));
    upperBound = objectiveValue + objectiveRadius;
    trace.recordIterate(center, P, objectiveValue, Math.max(0, violation), objectiveRadius);

    // Feasibility of the center is still required so that the last iterate the
    // viewport marks as the answer is a point of the region.
    if (feasible && incumbent.certifies(upperBound, tol)) {
      termination = "converged";
      break;
    }

    // cut normal g and its offset beta: keep { x : g'x <= g'center - beta }
    let beta: number;
    if (!feasible) {
      for (let j = 0; j < n; j++) g[j] = A.data[worstRow * n + j]!;
      beta = violation;
    } else {
      for (let j = 0; j < n; j++) g[j] = -c[j]!;
      // the incumbent can be better than this center's objective, in which case
      // the objective cut is itself a deep cut
      beta = incumbent.objective - objectiveValue;
    }

    const gPg = symmetricMatVec(P, g, Pg, n);
    if (!(gPg > 0) || !Number.isFinite(gPg)) {
      termination = "degenerate";
      break;
    }

    const alpha = deepCuts ? beta / Math.sqrt(gPg) : 0;
    if (alpha >= 1) {
      // the half-space misses the ellipsoid: nothing feasible and better than the incumbent is left
      termination = "infeasible";
      break;
    }

    const tau = (1 + n * alpha) / (n + 1);
    const delta = ((n * n) / (n * n - 1)) * (1 - alpha * alpha);
    const sigma = (2 * (1 + n * alpha)) / ((n + 1) * (1 + alpha));
    const invGPg = 1 / gPg;
    const step = tau / Math.sqrt(gPg);

    for (let j = 0; j < n; j++) center[j]! -= step * Pg[j]!;
    for (let j = 0; j < n; j++) {
      for (let k = j; k < n; k++) {
        const value = delta * (P[j * n + k]! - sigma * Pg[j]! * Pg[k]! * invGPg);
        nextP[j * n + k] = value;
        nextP[k * n + j] = value;
      }
    }
    P.set(nextP);

    if (!Number.isFinite(center[0]!) || !Number.isFinite(P[0]!)) {
      termination = "degenerate";
      break;
    }
  }

  // tested on the converged center, not on the incumbent: a ray shoot can adopt
  // a feasible point far outside the initial ellipsoid on an unbounded region
  // whose objective is nonetheless bounded, and that is not this condition
  if (termination === "converged" && onInitialBoundary(center, initialCenter, initialSemiAxes, n)) {
    termination = "unbounded";
  }

  const footer = localizationFooter(termination, trace.count, performance.now() - startTime, {
    infeasible: [incumbent.found ? "Cut away the last of the ellipsoid" : "No feasible point inside the initial ellipsoid"],
    degenerate: ["Ellipsoid degenerated numerically"],
    unbounded: ["Stopped on the initial ellipsoid boundary", "The objective is unbounded over this region: the method only searches inside the initial ellipsoid"],
  });
  trace.closeOnIncumbent(incumbent, upperBound);
  return trace.result(localizationLogHeader(n), footer);
}

// The smallest axis-aligned ellipsoid around the region's inflated bounding box: semi-axis
// sqrt(n) * halfExtent puts every box corner exactly on the boundary.
function initialEllipsoid(vertices: Vec[], n: number, scale: number) {
  const { center, halfExtents } = regionBoundingBox(vertices, n, scale);
  const P = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const semiAxis = Math.sqrt(n) * halfExtents[j]!;
    P[j * n + j] = semiAxis * semiAxis;
  }
  return { center, P };
}

// the initial ellipsoid is axis-aligned, so its quadratic form is a sum of squares over the semi-axes
function onInitialBoundary(x: Float64Array, center: Float64Array, semiAxes: Float64Array, n: number) {
  let quadratic = 0;
  for (let j = 0; j < n; j++) {
    const ratio = (x[j]! - center[j]!) / semiAxes[j]!;
    quadratic += ratio * ratio;
  }
  return quadratic >= 1 - INITIAL_BOUNDARY_TOLERANCE;
}

// out = P v, returning v'Pv
function symmetricMatVec(P: Float64Array, v: Float64Array, out: Float64Array, n: number) {
  let quadratic = 0;
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += P[j * n + k]! * v[k]!;
    out[j] = sum;
    quadratic += sum * v[j]!;
  }
  return quadratic;
}
