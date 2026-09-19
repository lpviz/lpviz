import {
  dot,
  infinityNorm,
  linesToDenseAb,
  matVec,
  transposedMatVec,
} from "@lpviz/math/blas";
import { solveDenseSystem } from "@lpviz/math/lapack";
import type { Lines, VecM, VecN } from "@lpviz/math/types";
import { formatMilliseconds } from "./time";

const MAX_ITERATIONS_LIMIT = 100_000;
const SIGMA_MIN = 1e-8;
const SIGMA_MAX = 1 - 1e-8;
const SIGMA_POWER = 3;

interface IPMOptions {
  eps_p: number;
  eps_d: number;
  eps_opt: number;
  maxit: number;
  alphaMax: number;
  correctorThreshold: number;
  verbose: boolean;
  /** Optional primal warm start; need not be feasible (infeasible-start method). */
  startPoint?: number[];
}

interface IPMSolutionData {
  x: VecN[];
  s: VecM[];
  y: VecM[];
  mu: number[];
  header: string;
  rows: Array<{
    kind: "ipm";
    iteration: number;
    x: number;
    y: number;
    objective: number;
    infeasibility: number;
    mu: number;
  }>;
  footer?: string;
}

export function ipm(lines: Lines, objective: VecN, opts: IPMOptions) {
  const {
    eps_p,
    eps_d,
    eps_opt,
    maxit,
    alphaMax,
    correctorThreshold,
    verbose,
    startPoint,
  } = opts;

  if (maxit > MAX_ITERATIONS_LIMIT) {
    throw new Error(`maxit > ${MAX_ITERATIONS_LIMIT} not allowed`);
  }

  const { A, b } = linesToDenseAb(lines);
  const c = Float64Array.from(objective, (value) => -value);
  const bneg = Float64Array.from(b, (value) => -value);
  const Aneg = Float64Array.from(A.data, (value) => -value);

  return ipmCore(
    {
      rows: A.rows,
      cols: A.cols,
      data: Aneg,
    },
    bneg,
    c,
    {
      eps_p,
      eps_d,
      eps_opt,
      maxit,
      alphaMax,
      correctorThreshold,
      verbose,
      startPoint,
    },
  );
}

function ipmCore(
  A: { rows: number; cols: number; data: Float64Array },
  b: Float64Array,
  c: Float64Array,
  opts: IPMOptions,
) {
  const {
    eps_p,
    eps_d,
    eps_opt,
    maxit,
    alphaMax,
    correctorThreshold,
    verbose,
    startPoint,
  } = opts;
  const m = A.rows;
  const n = A.cols;

  const solution: IPMSolutionData = {
    x: [],
    s: [],
    y: [],
    mu: [],
    header: " Iter        x        y        Obj     Infeas          µ",
    rows: [],
  };
  const res = { iterates: { solution } };

  let x = new Float64Array(n);
  let s = new Float64Array(m).fill(1);
  let y = new Float64Array(m).fill(1);
  if (startPoint && startPoint.length === n) {
    // Warm start from a user-chosen x0: relocate only the primal point and
    // keep the cold start's s = y = 1, so a start at the default position
    // reproduces the cold trajectory exactly. Feasibility of x0 is not
    // required — this is an infeasible-start method — but strict positivity
    // of (s, y) is: both sit on the diagonal of the Newton system and the
    // fraction-to-boundary rule only preserves positivity it starts with.
    // The centered choice satisfies it, gives every complementarity product
    // s_i*y_i = 1 (a tiny product makes the first affine directions explode),
    // and keeps the initial mu = 1 on scale for sigma = (mu_aff/mu)^3. The
    // cold start never zeroes the primal residual either (s = 1, not b - Ax),
    // so residuals are the solver's job in both cases.
    x.set(startPoint);
  }

  const ax = new Float64Array(m);
  const aty = new Float64Array(n);
  const rP = new Float64Array(m);
  const rD = new Float64Array(n);
  const rC = new Float64Array(m);
  const zeroP = new Float64Array(m);
  const zeroD = new Float64Array(n);
  const normal = createNormalEquations(A, s, y);
  const dxAff = new Float64Array(n);
  const dsAff = new Float64Array(m);
  const dyAff = new Float64Array(m);
  const dxCor = new Float64Array(n);
  const dsCor = new Float64Array(m);
  const dyCor = new Float64Array(m);
  const dx = new Float64Array(n);
  const ds = new Float64Array(m);
  const dy = new Float64Array(m);

  let iteration = 0;
  let converged = false;
  let failureMessage: string | null = null;
  const startTime = performance.now();

  if (verbose) console.log(solution.header);

  while (++iteration <= maxit) {
    matVec(A, x, ax);
    transposedMatVec(A, y, aty);

    for (let i = 0; i < m; i++) {
      rP[i] = b[i]! - ax[i]! + s[i]!;
    }
    for (let j = 0; j < n; j++) {
      rD[j] = c[j]! - aty[j]!;
    }

    const mu = dot(s, y) / m;
    const pObj = dot(c, x);
    const gap = Math.abs(pObj - dot(b, y)) / (1 + Math.abs(pObj));
    const pRes = infinityNorm(rP);

    logIter(solution, verbose, x, mu, pObj, pRes);
    pushIter(solution, x, s, y, mu);

    if (pRes <= eps_p && infinityNorm(rD) <= eps_d && gap <= eps_opt) {
      converged = true;
      break;
    }

    normal.form();
    for (let i = 0; i < m; i++) rC[i] = -s[i]! * y[i]!;

    try {
      normal.solve(rP, rD, rC, dxAff, dsAff, dyAff);
    } catch (error) {
      failureMessage = `IPM linear solve failed: ${error instanceof Error ? error.message : String(error)}`;
      if (verbose) console.log(failureMessage);
      break;
    }

    const alphaP = alphaStep(s, dsAff);
    const alphaD = alphaStep(y, dyAff);
    let muAff = 0;
    for (let i = 0; i < m; i++) {
      muAff += (s[i]! + alphaP * dsAff[i]!) * (y[i]! + alphaD * dyAff[i]!);
    }
    muAff /= m;

    if (!(alphaP >= correctorThreshold && alphaD >= correctorThreshold)) {
      // mu can reach exactly 0 when alphaMax = 1; (0/0)**p would be NaN
      const sigma =
        mu > 0
          ? Math.max(SIGMA_MIN, Math.min(SIGMA_MAX, (muAff / mu) ** SIGMA_POWER))
          : SIGMA_MIN;
      for (let i = 0; i < m; i++) {
        rC[i] = -(dsAff[i]! * dyAff[i]! - sigma * mu);
      }

      try {
        normal.solve(zeroP, zeroD, rC, dxCor, dsCor, dyCor);
      } catch (error) {
        failureMessage = `IPM corrector solve failed: ${error instanceof Error ? error.message : String(error)}`;
        if (verbose) console.log(failureMessage);
        break;
      }

      for (let j = 0; j < n; j++) dx[j] = dxAff[j]! + dxCor[j]!;
      for (let i = 0; i < m; i++) {
        ds[i] = dsAff[i]! + dsCor[i]!;
        dy[i] = dyAff[i]! + dyCor[i]!;
      }
    } else {
      dx.set(dxAff);
      ds.set(dsAff);
      dy.set(dyAff);
    }

    const stepP = alphaMax * alphaStep(s, ds);
    const stepD = alphaMax * alphaStep(y, dy);
    for (let j = 0; j < n; j++) x[j] += dx[j]! * stepP;
    for (let i = 0; i < m; i++) {
      s[i] += ds[i]! * stepP;
      y[i] += dy[i]! * stepD;
    }
  }

  const solveTime = performance.now() - startTime;
  logFinal(solution, verbose, converged, solveTime, failureMessage);
  return res;
}

//   [ A  -I   0 ] [dx]   [rP]        (primal residual)
//   [ 0   0  Aᵀ ] [ds] = [rD]        (dual residual)
//   [ 0   Y   S ] [dy]   [rC]        (complementarity)
//
//   (Aᵀ D A) dx = Aᵀ((rC + y∘rP)/s) − rD,   D = diag(y/s),
function createNormalEquations(
  A: { rows: number; cols: number; data: Float64Array },
  s: Float64Array,
  y: Float64Array,
) {
  const m = A.rows;
  const n = A.cols;
  const M = new Float64Array(n * n);
  const luScratch = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  const weighted = new Float64Array(m);
  return {
    form() {
      M.fill(0);
      for (let i = 0; i < m; i++) {
        const d = y[i]! / s[i]!;
        const offset = i * n;
        for (let j = 0; j < n; j++) {
          const dj = d * A.data[offset + j]!;
          for (let k = 0; k < n; k++) {
            M[j * n + k] += dj * A.data[offset + k]!;
          }
        }
      }
    },
    solve(
      rP: Float64Array,
      rD: Float64Array,
      rC: Float64Array,
      dx: Float64Array,
      ds: Float64Array,
      dy: Float64Array,
    ) {
      for (let i = 0; i < m; i++) {
        weighted[i] = (rC[i]! + y[i]! * rP[i]!) / s[i]!;
      }
      transposedMatVec(A, weighted, rhs);
      for (let j = 0; j < n; j++) rhs[j] -= rD[j]!;
      solveDenseSystem(M, n, rhs, dx, luScratch);
      matVec(A, dx, ds);
      for (let i = 0; i < m; i++) {
        ds[i] -= rP[i]!;
        dy[i] = (rC[i]! - y[i]! * ds[i]!) / s[i]!;
      }
    },
  };
}

function alphaStep(values: Float64Array, delta: Float64Array) {
  let alpha = 1;
  for (let i = 0; i < values.length; i++) {
    const direction = delta[i]!;
    if (direction < 0) {
      alpha = Math.min(alpha, -values[i]! / direction);
    }
  }
  return alpha;
}

function pushIter(
  d: IPMSolutionData,
  x: Float64Array,
  s: Float64Array,
  y: Float64Array,
  mu: number,
) {
  d.x.push(x.slice());
  d.s.push(s.slice());
  d.y.push(y.slice());
  d.mu.push(mu);
}

function logIter(
  d: IPMSolutionData,
  verbose: boolean,
  x: Float64Array,
  mu: number,
  pObj: number,
  pRes: number,
) {
  const row = {
    kind: "ipm" as const,
    iteration: d.x.length + 1,
    x: x[0] ?? 0,
    y: x[1] ?? 0,
    objective: -pObj,
    infeasibility: pRes,
    mu,
  };
  if (verbose) console.log(row);
  d.rows.push(row);
}

function logFinal(
  d: IPMSolutionData,
  verbose: boolean,
  converged: boolean,
  solveTime: number,
  failureMessage: string | null,
) {
  d.footer = failureMessage
    ? `${failureMessage}\nStopped after ${d.x.length} iterations in ${formatMilliseconds(solveTime)}\n`
    : converged
      ? `Converged to optimal solution in ${formatMilliseconds(solveTime)} / ${d.x.length} iterations\n`
      : `Did not converge after ${d.x.length} iterations in ${formatMilliseconds(solveTime)}\n`;
  if (verbose) console.log(d.footer);
}
