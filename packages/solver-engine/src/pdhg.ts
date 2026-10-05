import type { Lines, VecN } from "@lpviz/math/types";
import { pdhgEq } from "./pdhg_eq";
import { pdhgIneq } from "./pdhg_ineq";

interface PDHGOptions {
  ineq: boolean;
  halpern: boolean;
  maxit: number;
  eta: number;
  tau: number;
  tol: number;
  colorByBasis: boolean;
  /** Optional primal warm start; safe from any x0 (duals derived per mode). */
  startPoint?: number[];
}

export function pdhg(lines: Lines, objective: VecN, options: PDHGOptions) {
  const { ineq = false, halpern = false, maxit = 1000, eta = 0.25, tau = 0.25, tol = 1e-4, colorByBasis = false, startPoint } = options;
  const solverOptions = {
    maxit,
    eta,
    tau,
    tol,
    colorByBasis,
    halpern,
    startPoint,
  };
  return ineq ? pdhgIneq(lines, objective, solverOptions) : pdhgEq(lines, objective, solverOptions);
}
