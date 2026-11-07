// SCS (O'Donoghue, Chu, Parikh and Boyd 2016, "Conic optimization via operator splitting and
// homogeneous self-dual embedding") on `max c'x s.t. Ax <= b`: ADMM on the homogeneous self-dual
// embedding, the same embedding the homogeneous IPM and H-PDLP solve, so it certifies empty
// regions and unbounded objectives as well as finding optima.
//
// In SCS's form the LP is `min c̃'x s.t. Ax + s = b, s >= 0` with c̃ = -c. The embedding asks for
// u = (x, y, τ) and v = (0, s, κ) with v = Qu, u ∈ C = Rⁿ × R₊ᵐ × R₊, v ∈ C*, where
//
//        ⎡  0    Aᵀ   c̃ ⎤
//   Q =  ⎢ -A    0    b ⎥
//        ⎣ -c̃ᵀ  -bᵀ   0 ⎦.
//
// Q is skew-symmetric, so u'v = 0 there, and ADMM splits "v = Qu" from "u ∈ C, v ∈ C*" into
//   ũ = (I + Q)⁻¹(u + v)                                  (a linear solve, factored once)
//   u = Π_C(αũ + (1 - α)u - v)                            (project: clip y and τ at zero)
//   v = v - αũ - (1 - α)u_old + u                         (the scaled dual update)
// with SCS's relaxation α = 1.5, from u = v = (0, 0, 1). A solution with τ > 0 is (x, y, s)/τ; one
// with τ = 0 < κ is a Farkas certificate. The drawn trace is x/τ.

import { denseFromConstraints, dot } from "@lpviz/math/blas";
import { invertDenseMatrix } from "@lpviz/math/lapack";
import type { Constraint } from "@lpviz/math/types";
import { NumericTrace, type SolverResult } from "./result";

export interface SCSOptions {
  maxit: number;
  tol: number;
}

const RELAXATION = 1.5;

const norm = (v: ArrayLike<number>) => {
  let worst = 0;
  for (let i = 0; i < v.length; i++) worst = Math.max(worst, Math.abs(v[i]!));
  return worst;
};

/** SCS's ADMM on the homogeneous self-dual embedding of `max objective'x s.t. Ax <= b`. */
export function scs(constraints: readonly Constraint[], objective: Float64Array, { maxit, tol }: SCSOptions): SolverResult {
  const { A, b } = denseFromConstraints(constraints);
  const m = A.rows;
  const n = A.cols;
  const c = Float64Array.from(objective, (v) => -v);
  const size = n + m + 1;
  const T = n + m;

  // I + Q, inverted once: the only linear algebra in the run
  const M = new Float64Array(size * size);
  for (let k = 0; k < size; k++) M[k * size + k] = 1;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      const a = A.data[i * n + j]!;
      M[j * size + (n + i)] = a;
      M[(n + i) * size + j] = -a;
    }
    M[(n + i) * size + T] = b[i]!;
    M[T * size + (n + i)] = -b[i]!;
  }
  for (let j = 0; j < n; j++) {
    M[j * size + T] = c[j]!;
    M[T * size + j] = -c[j]!;
  }
  const solve = invertDenseMatrix(M, size, new Float64Array(size * size));

  const u = new Float64Array(size);
  const v = new Float64Array(size);
  u[T] = 1;
  v[T] = 1;
  const rhs = new Float64Array(size);
  const ut = new Float64Array(size);
  const before = new Float64Array(size);

  const trace = new NumericTrace(n, "eps", maxit);
  const scaleB = 1 + norm(b);
  const scaleC = 1 + norm(c);
  const point = new Float64Array(n);
  const residualP = new Float64Array(m);
  const residualD = new Float64Array(n);
  let status: "optimal" | "infeasible" | "unbounded" | undefined;

  for (let k = 0; k < maxit; k++) {
    for (let i = 0; i < size; i++) rhs[i] = u[i]! + v[i]!;
    for (let r = 0; r < size; r++) {
      let sum = 0;
      for (let q = 0; q < size; q++) sum += solve[r * size + q]! * rhs[q]!;
      ut[r] = sum;
    }
    before.set(u);
    for (let i = 0; i < size; i++) {
      const w = RELAXATION * ut[i]! + (1 - RELAXATION) * before[i]! - v[i]!;
      // x is free; y and τ live in the nonnegative orthant
      u[i] = i < n ? w : Math.max(w, 0);
    }
    for (let i = 0; i < size; i++) v[i] = v[i]! - RELAXATION * ut[i]! - (1 - RELAXATION) * before[i]! + u[i]!;

    // the iterate as an LP point: x, y and s = v's middle block, all over τ
    const tau = u[T];
    const kappa = v[T];
    const x = u.subarray(0, n);
    const y = u.subarray(n, T);
    const s = v.subarray(n, T);
    for (let i = 0; i < m; i++) {
      let ax = 0;
      for (let j = 0; j < n; j++) ax += A.data[i * n + j]! * x[j]!;
      residualP[i] = ax + s[i]! - b[i]! * tau;
    }
    for (let j = 0; j < n; j++) {
      let aty = 0;
      for (let i = 0; i < m; i++) aty += A.data[i * n + j]! * y[i]!;
      residualD[j] = aty + c[j]! * tau;
    }
    const cx = dot(c, x);
    const by = dot(b, y);

    if (tau > 0) {
      for (let j = 0; j < n; j++) point[j] = x[j]! / tau;
      const primal = norm(residualP) / tau / scaleB;
      const dual = norm(residualD) / tau / scaleC;
      const gap = Math.abs(cx + by) / tau / (1 + Math.abs(cx / tau) + Math.abs(by / tau));
      const eps = Math.max(primal, dual, gap);
      trace.record(point, -cx / tau, norm(residualP) / tau, eps);
      if (eps <= tol) {
        status = "optimal";
        break;
      }
    } else {
      trace.record(point, -dot(c, point), Infinity, Infinity);
    }

    // certificates, read off the unnormalized iterate once τ has collapsed against κ: a y >= 0
    // with Aᵀy = 0 and b'y < 0 proves Ax <= b empty; an x with Ax <= 0 and c̃'x < 0 is an improving ray
    if (tau < tol * Math.max(kappa, 1e-300) || tau === 0) {
      let aty = 0;
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let i = 0; i < m; i++) sum += A.data[i * n + j]! * y[i]!;
        aty = Math.max(aty, Math.abs(sum));
      }
      if (by < 0 && aty <= -tol * by) {
        status = "infeasible";
        break;
      }
      let ax = 0;
      for (let i = 0; i < m; i++) {
        let sum = 0;
        for (let j = 0; j < n; j++) sum += A.data[i * n + j]! * x[j]!;
        ax = Math.max(ax, sum);
      }
      if (cx < 0 && ax <= -tol * cx) {
        status = "unbounded";
        break;
      }
    }
  }

  const lead = status === "infeasible" ? "Certified primal infeasible" : status === "unbounded" ? "Certified unbounded" : undefined;
  return trace.finish({ converged: status === "optimal", lead }, { status });
}
