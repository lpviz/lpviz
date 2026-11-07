// Karmarkar's projective method on `max c'x s.t. Ax <= b` with slacks s = b - Ax > 0, in the
// potential-reduction form Gonzaga and Todd–Burrell gave it for this inequality form: minimize
// Karmarkar's potential q·log(z - c'x) - Σ log sᵢ, where z is an upper bound on the optimum, by a
// Newton-like step in the Dikin metric ‖S⁻¹A d‖ and a line search. The metric's unit ball, the
// Dikin ellipsoid, lies inside the region, and is drawn at every iterate. The step produces dual
// estimates y with Aᵀy = c; whenever they are nonnegative, b'y is a better bound and z drops to it.
// Karmarkar's projective transformation is exactly what turns his method into this one, so the
// iterates are his, without the simplex-shaped canonical form.
//
// Until the first bound is known the potential has nothing to push against, so the method steps
// towards the best point of the Dikin ellipsoid, d = H⁻¹c with H = AᵀS⁻²A, a fraction αmax of the
// way to the boundary (Dikin's affine-scaling step).
//
// It needs a strictly interior start: the dragged point if it is one, the Chebyshev center (the
// center of the largest inscribed ball) otherwise. It stops when the dual estimates are
// (nearly) nonnegative and the gap s'y between the two objectives is below the tolerance.

import { denseFromConstraints, dot, type DenseMatrix, rowDot, weightedGram } from "@lpviz/math/blas";
import { invertSymmetric } from "@lpviz/math/lapack";
import { chebyshevCenter } from "@lpviz/math/lp";
import type { Constraint } from "@lpviz/math/types";
import { LP_BOUND } from "./barrierCenters";
import { warmStart } from "./limits";
import { ellipsoidStride } from "./localization";
import { FloatBlock, NumericTrace, type SolverResult } from "./result";

export interface KarmarkarOptions {
  tol: number;
  maxit: number;
  /** the fraction of the way to the boundary each step takes before the first bound is known */
  alphaMax: number;
  startPoint?: readonly number[] | undefined;
}

const LINE_SEARCH_STEPS = 60;
const BACKTRACK = 0.5;
const REGULARIZATION = 1e-12;
const ESCAPE = 1e4;

const slacksAt = (A: DenseMatrix, b: Float64Array, x: Float64Array) => Float64Array.from(b, (bi, i) => bi - rowDot(A, i, x));

/** A strictly interior point: the start when it is one, the Chebyshev center otherwise; null when the region has no interior. */
function interiorStart(constraints: readonly Constraint[], A: DenseMatrix, b: Float64Array, start: readonly number[] | null): Float64Array | null {
  if (start) {
    const x = Float64Array.from(start);
    if (slacksAt(A, b, x).every((s) => s > 0)) return x;
  }
  // inside a box on the rows' own scale first, so an unbounded region's center is not thrown out to
  // the solver's far bound; the far bound only when the near box misses the region
  let scale = 1;
  for (let i = 0; i < A.rows; i++) scale = Math.max(scale, Math.abs(b[i]!) / (Math.hypot(...A.data.subarray(i * A.cols, (i + 1) * A.cols)) || 1));
  for (const box of [10 * scale, LP_BOUND]) {
    const ball = chebyshevCenter(constraints, A.cols, box);
    if (ball && ball.radius > 0 && ball.center.every(Number.isFinite)) return ball.center;
  }
  return null;
}

/** The largest t with s + t·ds > 0, Infinity when no slack shrinks. */
function stepToBoundary(s: Float64Array, ds: Float64Array): number {
  let t = Infinity;
  for (let i = 0; i < s.length; i++) if (ds[i]! < 0) t = Math.min(t, -s[i]! / ds[i]!);
  return t;
}

/** Whether c has a part outside the span of A's rows (the directions some row constrains). */
function freeImprovingDirection(A: DenseMatrix, c: Float64Array, tol: number): boolean {
  const n = A.cols;
  const span: Float64Array[] = [];
  for (let i = 0; i < A.rows; i++) {
    const v = Float64Array.from(A.data.subarray(i * n, (i + 1) * n));
    const norm = Math.hypot(...v);
    for (const u of span) {
      const p = dot(u, v);
      for (let j = 0; j < n; j++) v[j]! -= p * u[j]!;
    }
    const left = Math.hypot(...v);
    if (left > 1e-9 * norm) span.push(v.map((value) => value / left));
  }
  const rest = Float64Array.from(c);
  for (const u of span) {
    const p = dot(u, rest);
    for (let j = 0; j < n; j++) rest[j]! -= p * u[j]!;
  }
  return Math.hypot(...rest) > tol * (1 + Math.hypot(...c));
}

/** Karmarkar's method on `max objective'x s.t. Ax <= b`. */
export function karmarkar(constraints: readonly Constraint[], objective: Float64Array, { tol, maxit, alphaMax, startPoint }: KarmarkarOptions): SolverResult {
  const name = "Karmarkar's method";
  const { A, b } = denseFromConstraints(constraints);
  const m = A.rows;
  const n = A.cols;
  const c = objective;
  // the potential's weight on the gap: above m, so each step can cut the potential by a constant
  const q = m + Math.sqrt(m);
  const x0 = interiorStart(constraints, A, b, warmStart(startPoint, n));
  if (!x0) throw new Error(`${name} needs a region with an interior to start from.`);
  let x = x0;

  const trace = new NumericTrace(n, "Gap", maxit);
  const ellipsoids = new FloatBlock(ellipsoidStride(n));
  const H = new Float64Array(n * n);
  const g = new Float64Array(n);
  const d = new Float64Array(n);
  const As = new Float64Array(m);
  // Karmarkar's upper bound on the optimum: none yet
  let bound = Infinity;
  let stop: { converged: boolean; lead?: string; after?: string } | null = null;

  // how far out an iterate has to get before the run reads the LP as unbounded
  let reach = 1 + Math.max(...x.map(Math.abs));
  for (let i = 0; i < m; i++) reach = Math.max(reach, Math.abs(b[i]!) / (Math.hypot(...A.data.subarray(i * n, (i + 1) * n)) || 1));
  const escape = ESCAPE * reach;

  // a direction no row constrains, along which the objective improves: the LP is unbounded, and
  // the Dikin metric would be singular along it
  const free = freeImprovingDirection(A, c, tol);
  if (free) {
    trace.record(x, dot(c, x), 0, Infinity);
    const unbounded = { converged: false, lead: "Stopped", after: "No constraint limits a direction along which the objective improves: the LP is unbounded." };
    return trace.finish(unbounded);
  }

  for (let k = 0; ; k++) {
    const s = slacksAt(A, b, x);
    weightedGram(A, (i) => 1 / (s[i]! * s[i]!), H);
    // a whisker of regularization keeps H invertible when the rows leave a direction free (a strip);
    // c has no part along such a direction (that case ended before the loop), so nothing moves along it
    let trace0 = 0;
    for (let j = 0; j < n; j++) trace0 += H[j * n + j]!;
    for (let j = 0; j < n; j++) H[j * n + j]! += REGULARIZATION * trace0;
    const Hinv = invertSymmetric(H, n);
    if (!Hinv) {
      stop = { converged: false, lead: "Stopped", after: "The Dikin metric is singular: the rows do not span every direction." };
      break;
    }
    const gap0 = Number.isFinite(bound) ? bound - dot(c, x) : 0;
    // the direction: minus the potential's gradient through H⁻¹, or H⁻¹c (Dikin's step) with no bound yet
    for (let j = 0; j < n; j++) {
      let barrier = 0;
      for (let i = 0; i < m; i++) barrier += A.data[i * n + j]! / s[i]!;
      g[j] = Number.isFinite(bound) ? (q * c[j]!) / gap0 - barrier : c[j]!;
    }
    for (let j = 0; j < n; j++) {
      let v = 0;
      for (let l = 0; l < n; l++) v += Hinv[j * n + l]! * g[l]!;
      d[j] = v;
    }
    for (let i = 0; i < m; i++) As[i] = rowDot(A, i, d);
    // dual estimates with Aᵀy = c: before a bound, y = S⁻²A H⁻¹c; after, the ones the
    // potential step implies, y = (gap/m) S⁻¹(e + S⁻¹A d) (see the header)
    const y = new Float64Array(m);
    if (Number.isFinite(bound)) {
      for (let i = 0; i < m; i++) y[i] = (gap0 / q) * (1 / s[i]! + As[i]! / (s[i]! * s[i]!));
    } else {
      // H⁻¹c is d itself before the first bound
      for (let i = 0; i < m; i++) y[i] = As[i]! / (s[i]! * s[i]!);
    }
    const gap = dot(s, y);
    // the dual estimates' own errors: a negative entry, or Aᵀy missing c (only under the regularization)
    let residual = 0;
    for (let j = 0; j < n; j++) {
      let v = -c[j]!;
      for (let i = 0; i < m; i++) v += A.data[i * n + j]! * y[i]!;
      residual = Math.max(residual, Math.abs(v));
    }
    const infeasibility = Math.max(0, -Math.min(...y), residual / (1 + Math.max(...c.map(Math.abs))));
    // only an exactly nonnegative y with Aᵀy = c certifies b'y as an upper bound
    // (applied after this step: the step descends the potential of the bound it was computed for)
    const nextBound = y.every((v) => v >= 0) && residual <= tol ? Math.min(bound, dot(b, y)) : bound;
    trace.record(x, dot(c, x), infeasibility, Math.abs(gap));
    // the Dikin ellipsoid { x + u : uᵀHu <= 1 }: shape H⁻¹, packed as its upper triangle
    const at = ellipsoids.add();
    ellipsoids.data.set(x, at);
    for (let r = 0, p = at + n; r < n; r++) for (let col = r; col < n; col++) ellipsoids.data[p++] = Hinv[r * n + col]!;

    if (infeasibility <= tol && Math.abs(gap) <= tol * (1 + Math.abs(dot(c, x)))) {
      stop = { converged: true };
      break;
    }
    if (k + 1 >= maxit) break;

    // Ad is the slack's rate of decrease along d: s(t) = s - t·Ad
    const ds = Float64Array.from(As, (v) => -v);
    const boundary = stepToBoundary(s, ds);
    if (!Number.isFinite(boundary) && !Number.isFinite(bound)) {
      if (dot(c, d) > 0) {
        stop = { converged: false, lead: "Stopped", after: "The step direction improves the objective and no constraint ever blocks it: the LP is unbounded." };
        break;
      }
      stop = { converged: false, lead: "Stopped", after: "The step direction has no blocking constraint." };
      break;
    }
    let t = alphaMax * boundary;
    if (Number.isFinite(bound)) {
      // a line search on Karmarkar's potential, from the boundary fraction down
      const potential = (point: Float64Array) => {
        const slack = slacksAt(A, b, point);
        const room = bound - dot(c, point);
        if (!(room > 0) || slack.some((v) => !(v > 0))) return Infinity;
        let value = q * Math.log(room);
        for (const v of slack) value -= Math.log(v);
        return value;
      };
      const here = potential(x);
      // from just short of the boundary, or from the full step when nothing blocks it
      t = Number.isFinite(boundary) ? 0.99 * boundary : 1;
      let tried = 0;
      while (tried++ < LINE_SEARCH_STEPS && !(potential(x.map((v, j) => v + t * d[j]!)) < here)) t *= BACKTRACK;
      if (tried > LINE_SEARCH_STEPS) {
        stop = { converged: false, lead: "Stopped", after: "The potential stopped decreasing." };
        break;
      }
    }
    x = x.map((v, j) => v + t * d[j]!);
    bound = nextBound;
    // a recession direction that improves the objective: the iterates run off to infinity and the
    // objective with them, while every step still has a blocking row
    if (Math.max(...x.map(Math.abs)) > escape) {
      trace.record(x, dot(c, x), Infinity, Infinity);
      stop = { converged: false, lead: "Stopped", after: "The iterates left every bound while the objective kept improving: the LP is unbounded." };
      break;
    }
  }

  return trace.finish(stop ?? { converged: false }, { ellipsoids: { data: ellipsoids.finish(), count: ellipsoids.count, stride: ellipsoids.stride } });
}
