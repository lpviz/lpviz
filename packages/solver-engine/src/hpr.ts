// HPR-LP (Chen, Sun, Yuan, Zhang and Zhao 2024, "HPR-LP: An implementation of an HPR method for
// solving linear programming", arXiv:2408.12179) on `max c'x s.t. Ax <= b`: the Halpern
// Peaceman–Rachford method with semi-proximal terms, with the paper's restarts and penalty update.
//
// The paper's LP is `min c̃'x s.t. A₂x >= b₂, x ∈ C`; here c̃ = -c, A₂ = -A, b₂ = -b and C is all of
// Rⁿ (x is free). With T₁ = λI - AAᵀ, λ >= λ₁(AAᵀ), one Peaceman–Rachford step (its Steps 6-9) is
//   x̄ = x + σ(A₂ᵀy - c̃)                         (Π_C is the identity, so z̄ = 0)
//   ȳ = Π₊(y + (b₂ - A₂(2x̄ - x)) / (λσ))
//   ŵ = 2w̄ - w                                   (the reflection: Peaceman–Rachford, not Douglas–Rachford)
//   w = w⁰/(t + 2) + (t + 1)ŵ/(t + 2)            (Halpern's anchor at the inner loop's start w⁰)
// for w = (y, x). The inner loop restarts from w̄ when R̃ = ‖w - ŵ‖_M has fallen to α₁ = 0.2 of its
// value at the restart, or to α₂ = 0.6 and stopped falling, or after α₃ = 0.2 of all iterations;
// each restart moves σ toward (1/√λ)‖Δx‖/‖Δy‖, the paper's estimate of the σ that balances the
// primal and dual distances to a solution (halfway, in log: see the restart). The metric M is approximated by λσ‖Δy‖² + ‖Δx‖²/σ, the part of
// it that does not need A.
//
// The run stops on PDLP's relative KKT test at the bar iterate (x̄, ȳ), which the paper also uses;
// like PDHG, HPR-LP has no certificate of infeasibility or unboundedness, and runs to the cap.

import { denseFromConstraints, dot } from "@lpviz/math/blas";
import type { Constraint } from "@lpviz/math/types";
import { warmStart } from "./limits";
import { NumericTrace, type SolverResult } from "./result";

export interface HPROptions {
  maxit: number;
  tol: number;
  /** Optional primal warm start; y starts at zero. */
  startPoint?: readonly number[] | undefined;
}

const ALPHA_1 = 0.2;
const ALPHA_2 = 0.6;
const ALPHA_3 = 0.2;
const POWER_ITERATIONS = 200;

/** λ₁(AAᵀ) = λ₁(AᵀA), by power iteration on the small n × n Gram matrix. */
function largestEigenvalue(A: Float64Array, m: number, n: number): number {
  const G = new Float64Array(n * n);
  for (let i = 0; i < m; i++) for (let p = 0; p < n; p++) for (let q = 0; q < n; q++) G[p * n + q]! += A[i * n + p]! * A[i * n + q]!;
  let v = new Float64Array(n).fill(1 / Math.sqrt(n));
  let lambda = 0;
  for (let k = 0; k < POWER_ITERATIONS; k++) {
    const w = new Float64Array(n);
    for (let p = 0; p < n; p++) for (let q = 0; q < n; q++) w[p]! += G[p * n + q]! * v[q]!;
    const norm = Math.hypot(...w);
    if (!(norm > 0)) return 0;
    lambda = norm;
    v = w.map((value) => value / norm);
  }
  return lambda;
}

const norm2 = (v: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  return Math.sqrt(sum);
};

/** HPR-LP on `max objective'x s.t. Ax <= b`. */
export function hpr(constraints: readonly Constraint[], objective: Float64Array, { maxit, tol, startPoint }: HPROptions): SolverResult {
  const { A, b } = denseFromConstraints(constraints);
  const m = A.rows;
  const n = A.cols;
  const a = A.data;
  const c = objective;
  // a hair over λ₁ keeps T₁ = λI - AAᵀ positive semidefinite under rounding
  const lambda = Math.max(largestEigenvalue(a, m, n) * (1 + 1e-10), 1e-12);

  // w = (y, x); w0 the inner loop's anchor, bar the latest bar iterate
  const x = new Float64Array(n);
  const y = new Float64Array(m);
  const x0 = warmStart(startPoint, n);
  if (x0) x.set(x0);
  const anchorX = Float64Array.from(x);
  const anchorY = Float64Array.from(y);
  const xBar = new Float64Array(n);
  const yBar = new Float64Array(m);
  const reflected = new Float64Array(n);
  let sigma = 1;

  const trace = new NumericTrace(n, "eps", maxit);
  const scaleB = 1 + norm2(b);
  const scaleC = 1 + norm2(c);
  let converged = false;
  let t = 0;
  let restartR = Infinity;
  let previousR = Infinity;

  for (let k = 0; k < maxit; k++) {
    // x̄ = x + σ(A₂ᵀy - c̃) = x - σ(Aᵀy - c)
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let i = 0; i < m; i++) sum += a[i * n + j]! * y[i]!;
      xBar[j] = x[j]! - sigma * (sum - c[j]!);
      reflected[j] = 2 * xBar[j]! - x[j]!;
    }
    // ȳ = Π₊(y + (b₂ - A₂(2x̄ - x))/(λσ)) = Π₊(y + (A(2x̄ - x) - b)/(λσ))
    for (let i = 0; i < m; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) sum += a[i * n + j]! * reflected[j]!;
      yBar[i] = Math.max(0, y[i]! + (sum - b[i]!) / (lambda * sigma));
    }

    // PDLP's relative KKT test at the bar iterate
    let primal = 0;
    for (let i = 0; i < m; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) sum += a[i * n + j]! * xBar[j]!;
      primal += Math.max(0, sum - b[i]!) ** 2;
    }
    let dual = 0;
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let i = 0; i < m; i++) sum += a[i * n + j]! * yBar[i]!;
      dual += (sum - c[j]!) ** 2;
    }
    const cx = dot(c, xBar);
    const by = dot(b, yBar);
    const eps = Math.max(Math.sqrt(primal) / scaleB, Math.sqrt(dual) / scaleC, Math.abs(cx - by) / (1 + Math.abs(cx) + Math.abs(by)));
    trace.record(xBar, cx, Math.sqrt(primal), eps);
    if (eps <= tol) {
      converged = true;
      break;
    }

    // ŵ = 2w̄ - w, and R̃ = ‖w - ŵ‖_M = 2‖w - w̄‖_M
    let dx = 0;
    let dy = 0;
    for (let j = 0; j < n; j++) dx += (x[j]! - xBar[j]!) ** 2;
    for (let i = 0; i < m; i++) dy += (y[i]! - yBar[i]!) ** 2;
    const R = 2 * Math.sqrt(lambda * sigma * dy + dx / sigma);
    if (t === 0) restartR = R;

    const restart = t > 0 && (R <= ALPHA_1 * restartR || (R <= ALPHA_2 * restartR && R > previousR) || t >= ALPHA_3 * k);
    if (restart) {
      // restart from w̄, with σ from the distance the inner loop covered
      const deltaX = Math.hypot(...xBar.map((v, j) => v - anchorX[j]!));
      const deltaY = Math.hypot(...yBar.map((v, i) => v - anchorY[i]!));
      const errorP = Math.sqrt(primal) / scaleB;
      const errorD = Math.sqrt(dual) / scaleC;
      const ratio = errorD / errorP;
      const usable = deltaX > 1e-16 && deltaX < 1e12 && deltaY > 1e-16 && deltaY < 1e12 && ratio > 1e-8 && ratio < 1e8;
      // (lpviz smooths the update in log, as PDLP smooths its primal weight: on these unscaled
      // problems a nearly still y sends the raw ratio up by orders of magnitude per restart)
      sigma = usable ? Math.sqrt(sigma * (deltaX / (Math.sqrt(lambda) * deltaY))) : 1;
      x.set(xBar);
      y.set(yBar);
      anchorX.set(xBar);
      anchorY.set(yBar);
      trace.markRestart();
      t = 0;
      previousR = Infinity;
      continue;
    }

    // the Halpern step toward the reflection, anchored at the inner loop's start
    const weight = 1 / (t + 2);
    for (let j = 0; j < n; j++) x[j] = weight * anchorX[j]! + (1 - weight) * (2 * xBar[j]! - x[j]!);
    for (let i = 0; i < m; i++) y[i] = weight * anchorY[i]! + (1 - weight) * (2 * yBar[i]! - y[i]!);
    previousR = R;
    t++;
  }

  return trace.finish({ converged });
}
