// The primal-dual active-set method (Hintermüller, Ito and Kunisch's semismooth Newton) on
// `max c'x s.t. Ax <= b`. On the LP itself the method is ill-posed: the Newton system holds the
// active rows tight, which is square only when exactly n of them are active. So it runs on the
// proximal method of multipliers instead: around a primal center z and a dual center w, each
// subproblem
//
//   max_x min_{y >= 0}  c'x - y'(Ax - b) - (ρ/2)|x - z|² + (δ/2)|y - w|²
//
// is strictly concave-convex, x = z + (c - Aᵀy)/ρ, and y solves the bound-constrained QP
//
//   min_{y >= 0}  ½ y'Hy - q'y,   H = AAᵀ/ρ + δI,   q = A(z + c/ρ) - b + δw,
//
// whose Hessian is positive definite on any active set. PDAS solves it: the active set T is the
// rows whose multiplier is free (the rest are held at zero); a Newton step solves H_TT y_T = q_T,
// then T drops the rows whose multiplier went negative and adds the rows the gradient says want
// one (a broken row, regularized), all at once. When T repeats, the subproblem is solved and its
// solution becomes the next centers. The proximal point method terminates finitely on an LP, so
// the centers reach an optimal primal-dual pair; two checks after each proximal step end the walk
// as soon as the active set says how it ends instead of waiting for the centers to creep there:
// n independent active rows whose exact KKT point is optimal (identification, optional), and a
// proximal step repeated along a ray that improves the objective and breaks no row (unboundedness).
// Sliding along one face, the centers move by the face's share of c/ρ per step, so the weights
// optionally halve while the active set holds.

import { denseFromConstraints, type DenseMatrix, dot, rowDot } from "@lpviz/math/blas";
import { trySolveDenseSystem } from "@lpviz/math/lapack";
import type { Constraint } from "@lpviz/math/types";
import { fmtExpUnsigned, fmtIterate, fmtRowSet, rowSetHeader, fmtIteration, ITERATION_COLUMN_WIDTH, iterateHeaders, logColumnWidths, solveFooter } from "./fmt";
import { assertAtMost, MAX_ITERATIONS, warmStart } from "./limits";
import { FloatBlock, iteratesOf, type SolverResult } from "./result";

export interface PDASOptions {
  tol: number;
  /** the primal proximal weight ρ: a subproblem moves the center at most |c|/ρ */
  rho: number;
  /** the dual proximal weight δ: how far a subproblem may break a row, per unit of multiplier change */
  delta: number;
  /** halve both weights whenever two proximal steps in a row end on the same active set */
  shrinkWeights: boolean;
  /** stop as soon as n active rows meet at a vertex that is optimal for the LP itself */
  identify: boolean;
  /** the cap on Newton steps, over every subproblem */
  maxit: number;
  /** the first primal center, which is also the first iterate; the origin when absent */
  startPoint?: readonly number[] | undefined;
}

/** The log marker of the Newton step that solved its subproblem, after which the centers move. */
export const PROX_STEP_MARKER = "p";
/** The log marker of the vertex the active set identified as optimal, the walk's last iterate. */
export const IDENTIFIED_MARKER = "*";
/** The log marker of a Lawson-Hanson step, which finishes a subproblem on which PDAS cycled. */
export const FALLBACK_MARKER = "f";

// a multiplier this far below zero leaves the active set, a gradient this far below zero enters it:
// rounding noise on a degenerate row must not flip it back and forth
const ACTIVE_SET_SLACK = 1e-12;
// the floor the proximal weights shrink to, far below where the subproblems stop changing anything
const MIN_WEIGHT = 1e-9;

// The KKT residual of (x, y) for the LP: the largest broken row, the stationarity gap |c - Aᵀy|∞
// and the complementarity gap max_i y_i |b_i - a_i x|.
function kktResidual(A: DenseMatrix, b: Float64Array, c: Float64Array, x: Float64Array, y: Float64Array): number {
  const { rows: m, cols: n } = A;
  let infeasibility = 0;
  let complementarity = 0;
  for (let i = 0; i < m; i++) {
    const excess = rowDot(A, i, x) - b[i]!;
    infeasibility = Math.max(infeasibility, excess);
    complementarity = Math.max(complementarity, y[i]! * Math.abs(excess));
  }
  let stationarity = 0;
  for (let j = 0; j < n; j++) {
    let aty = 0;
    for (let i = 0; i < m; i++) aty += A.data[i * n + j]! * y[i]!;
    stationarity = Math.max(stationarity, Math.abs(c[j]! - aty));
  }
  return Math.max(infeasibility, stationarity, complementarity);
}

// The exact KKT point of the LP on `active`, when it has n rows: the vertex where they meet, if that
// vertex breaks no row and its multipliers A_Tᵀy = c are nonnegative; else null.
function identifiedVertex(A: DenseMatrix, b: Float64Array, c: Float64Array, active: readonly number[], tol: number): Float64Array | null {
  const n = A.cols;
  if (active.length !== n) return null;
  const rows = Float64Array.from(active.flatMap((i) => Array.from(A.data.subarray(i * n, (i + 1) * n))));
  const columns = new Float64Array(n * n);
  for (let r = 0; r < n; r++) for (let j = 0; j < n; j++) columns[j * n + r] = rows[r * n + j]!;
  const vertex = new Float64Array(n);
  const multipliers = new Float64Array(n);
  if (
    !trySolveDenseSystem(
      rows,
      n,
      Float64Array.from(active, (i) => b[i]!),
      vertex,
    ) ||
    !trySolveDenseSystem(columns, n, c, multipliers)
  )
    return null;
  if (multipliers.some((value) => value < -tol)) return null;
  for (let i = 0; i < A.rows; i++) if (rowDot(A, i, vertex) - b[i]! > tol * (1 + Math.abs(b[i]!))) return null;
  return vertex;
}

/** PDAS on the proximal subproblems of `max objective'x s.t. Ax <= b`, from the given start (or the origin). */
export function pdas(constraints: readonly Constraint[], objective: Float64Array, { tol, rho: rho0, delta: delta0, shrinkWeights, identify, maxit, startPoint }: PDASOptions): SolverResult {
  assertAtMost("maxit", maxit, MAX_ITERATIONS);
  if (!(rho0 > 0) || !(delta0 > 0)) throw new Error("PDAS needs positive proximal weights");
  const startTime = performance.now();
  const { A, b } = denseFromConstraints(constraints);
  const { rows: m, cols: n } = A;
  const c = Float64Array.from(objective);
  const gram = new Float64Array(m * m);
  for (let i = 0; i < m; i++) for (let k = 0; k <= i; k++) gram[i * m + k] = gram[k * m + i] = rowDot(A, i, A.data.subarray(k * n, (k + 1) * n));

  const z = Float64Array.from(warmStart(startPoint, n) ?? new Float64Array(n));
  const w = new Float64Array(m);
  const y = new Float64Array(m);
  const x = new Float64Array(n);
  const q = new Float64Array(m);
  let active: number[] = [];
  let rho = rho0;
  let delta = delta0;
  let previousActive: string | null = null;

  const iterates = new FloatBlock(n);
  const { measure } = logColumnWidths(n);
  const header = `${"Iter".padStart(ITERATION_COLUMN_WIDTH)} ${iterateHeaders(n)} ${"KKT".padStart(measure)} ${rowSetHeader("Active")}\n`;
  const rows: string[] = [];
  let proxSteps = 0;
  let fallbacks = 0;
  let status: "optimal" | "unbounded" | undefined;
  const step = new Float64Array(n);
  // the KKT residual per iterate: the log's column and the height the 3D view lifts it by
  const residuals: number[] = [];
  const record = (point: Float64Array, multipliers: Float64Array, marker: string, rowsShown: readonly number[]) => {
    const residual = kktResidual(A, b, c, point, multipliers);
    iterates.push(point);
    residuals.push(residual);
    rows.push(`${fmtIteration(rows.length + 1, marker)} ${fmtIterate(point, dot(c, point))} ${fmtExpUnsigned(residual, measure, 1)} ${fmtRowSet(rowsShown)}`);
    return residual;
  };

  // x = z + (c - Aᵀy)/ρ
  const primalOf = (multipliers: Float64Array) => {
    for (let j = 0; j < n; j++) {
      let aty = 0;
      for (let i = 0; i < m; i++) aty += A.data[i * n + j]! * multipliers[i]!;
      x[j] = z[j]! + (c[j]! - aty) / rho;
    }
  };
  // The Newton step on `free`: H_FF y_F = q_F with the rest of y at zero, into y and its x.
  const solveOn = (free: readonly number[]) => {
    y.fill(0);
    const size = free.length;
    if (size > 0) {
      const H = new Float64Array(size * size);
      free.forEach((i, r) => {
        free.forEach((k, s) => (H[r * size + s] = gram[i * m + k]! / rho));
        H[r * size + r]! += delta;
      });
      const solution = new Float64Array(size);
      if (
        !trySolveDenseSystem(
          H,
          size,
          Float64Array.from(free, (i) => q[i]!),
          solution,
        )
      )
        throw new Error("PDAS: singular Newton system");
      free.forEach((i, r) => (y[i] = solution[r]!));
    }
    primalOf(y);
  };
  // (Hy - q)_i for a row held at zero: negative when the row is broken, net of the regularization
  const wantsMultiplier = (i: number) => rowDot(A, i, x) - b[i]! + delta * w[i]! > ACTIVE_SET_SLACK;

  // Lawson and Hanson's active-set method from the projected multipliers: monotone in the
  // subproblem's objective, so finite where PDAS cycled. Each solve is an iterate.
  const lawsonHanson = (start: readonly number[]): boolean => {
    const previous = Float64Array.from(y, (value) => Math.max(0, value));
    let free = start.filter((i) => previous[i]! > 0);
    while (true) {
      if (rows.length >= maxit) return false;
      solveOn(free);
      const blocked = free.filter((i) => y[i]! < 0);
      if (blocked.length > 0) {
        // step from the previous feasible multipliers towards the solve until one hits zero
        let alpha = 1;
        for (const i of blocked) alpha = Math.min(alpha, previous[i]! / (previous[i]! - y[i]!));
        for (const i of free) y[i] = previous[i]! + alpha * (y[i]! - previous[i]!);
        free = free.filter((i) => y[i]! > ACTIVE_SET_SLACK);
        for (let i = 0; i < m; i++) if (!free.includes(i)) y[i] = 0;
        primalOf(y);
      } else {
        let entering = -1;
        let mostBroken = ACTIVE_SET_SLACK;
        for (let i = 0; i < m; i++) {
          if (free.includes(i)) continue;
          const excess = rowDot(A, i, x) - b[i]! + delta * w[i]!;
          if (excess > mostBroken) {
            mostBroken = excess;
            entering = i;
          }
        }
        if (entering === -1) {
          active = free;
          return true;
        }
        free = [...free, entering].sort((p, q) => p - q);
      }
      previous.set(y);
      if (record(x, y, FALLBACK_MARKER, free) <= tol) {
        status = "optimal";
        return false;
      }
    }
  };

  // the first proximal center is the first iterate, so the path begins where the start marker sits
  record(z, w, "", []);

  outer: while (rows.length < maxit) {
    // the subproblem around (z, w): q = A(z + c/ρ) - b + δw
    for (let i = 0; i < m; i++) q[i] = rowDot(A, i, z) + rowDot(A, i, c) / rho - b[i]! + delta * w[i]!;
    const seen = new Set<string>();

    while (true) {
      if (rows.length >= maxit) break outer;
      solveOn(active);

      // the next active set: keep the rows whose multiplier stays nonnegative, add the rows that
      // want one
      const isActive = new Set(active);
      const next: number[] = [];
      for (let i = 0; i < m; i++) if (isActive.has(i) ? y[i]! >= -ACTIVE_SET_SLACK : wantsMultiplier(i)) next.push(i);
      const key = next.join(",");
      const solved = key === active.join(",");
      seen.add(active.join(","));

      if (record(x, y, solved ? PROX_STEP_MARKER : "", active) <= tol) {
        status = "optimal";
        break outer;
      }
      if (solved) break;
      // an active set seen before in this subproblem: PDAS is cycling, so finish the subproblem
      // with the monotone method
      if (seen.has(key)) {
        fallbacks++;
        if (!lawsonHanson(active)) break outer;
        break;
      }
      active = next;
    }

    // the proximal step: the subproblem's solution is the next pair of centers
    proxSteps++;
    const vertex = identify ? identifiedVertex(A, b, c, active, tol) : null;
    if (vertex && rows.length < maxit) {
      const multipliers = new Float64Array(m);
      primalMultipliers(A, c, active, multipliers);
      record(vertex, multipliers, IDENTIFIED_MARKER, active);
      status = "optimal";
      break;
    }
    if (isImprovingRay(A, c, x, z, step, tol)) {
      status = "unbounded";
      break;
    }
    z.set(x);
    w.set(y);
    // the same active set twice running: the centers are sliding along one face, at a pace the
    // weights set, so halve them (the proximal point method converges faster as they shrink)
    const key = active.join(",");
    if (shrinkWeights && key === previousActive && rho > MIN_WEIGHT) {
      rho /= 2;
      delta /= 2;
    }
    previousActive = key;
  }

  const footer = solveFooter(status === "optimal", rows.length, performance.now() - startTime, status === "unbounded" ? "Unbounded LP" : undefined);
  const tally = `${proxSteps} proximal steps${fallbacks > 0 ? `, ${fallbacks} finished by Lawson-Hanson after a cycle` : ""}`;
  const note = status === "unbounded" ? "The proximal step repeats along a ray that improves the objective and breaks no row: the LP is unbounded.\n" : "";
  return {
    iterates: iteratesOf(iterates),
    convergence: Float64Array.from(residuals),
    log: [{ header, rows, footer: `${note}${tally}\n${footer}` }],
    status,
  };
}

// The multipliers of the n active rows, A_Tᵀy_T = c, scattered into `out` (zero elsewhere).
function primalMultipliers(A: DenseMatrix, c: Float64Array, active: readonly number[], out: Float64Array): void {
  const n = A.cols;
  const columns = new Float64Array(n * n);
  active.forEach((i, r) => {
    for (let j = 0; j < n; j++) columns[j * n + r] = A.data[i * n + j]!;
  });
  const solution = new Float64Array(n);
  trySolveDenseSystem(columns, n, c, solution);
  active.forEach((i, r) => (out[i] = solution[r]!));
}

// Whether the proximal step x - z repeats the previous one's direction (kept in `previous` as a unit
// vector, which this updates) along a direction d with c·d > 0 and A d <= 0: a ray of the region that
// improves the objective forever, the certificate of an unbounded LP. Directions, not steps: shrinking
// the weights doubles the step each time, which would hold the test off until the weights bottom out.
function isImprovingRay(A: DenseMatrix, c: Float64Array, x: Float64Array, z: Float64Array, previous: Float64Array, tol: number): boolean {
  const n = A.cols;
  const d = Float64Array.from(x, (value, j) => value - z[j]!);
  const length = Math.hypot(...d);
  let repeats = length > tol;
  for (let j = 0; j < n; j++) if (Math.abs(d[j]! / length - previous[j]!) > tol) repeats = false;
  previous.set(length > tol ? d.map((value) => value / length) : d);
  if (!repeats || dot(c, d) <= tol * length) return false;
  for (let i = 0; i < A.rows; i++) if (rowDot(A, i, d) > tol * length) return false;
  return true;
}
