import type { Lines, VecN, Vertices } from "@lpviz/math/types";
import { centralPath } from "@lpviz/solver-engine/centralPath";
import { cuttingPlane } from "@lpviz/solver-engine/cuttingPlane";
import { ellipsoid, type EllipsoidResultData } from "@lpviz/solver-engine/ellipsoid";
import { ipm } from "@lpviz/solver-engine/ipm";
import { pdhg } from "@lpviz/solver-engine/pdhg";
import { simplex, type EnteringRule, type LeavingRule } from "@lpviz/solver-engine/simplex";
import { packSolverResponse } from "./resultPacking";

import type { EllipsoidQueryPoint } from "@/features/core/store";
import type { CentralPathResult, IterateResult, PackedSolver, SimplexResult } from "./solverService";

export type SolverWorkerPayload =
  | { solver: "ipm"; lines: Lines; objective: VecN; startPoint?: number[]; alphaMax: number; correctorThreshold: number; maxit: number }
  | { solver: "simplex"; lines: Lines; objective: VecN; startVertex?: number[]; dual: boolean; enteringRule: EnteringRule; leavingRule: LeavingRule }
  | { solver: "pdhg"; lines: Lines; objective: VecN; startPoint?: number[]; ineq: boolean; halpern: boolean; maxit: number; eta: number; tau: number; colorByBasis: boolean }
  | { solver: "central"; vertices: Vertices; lines: Lines; objective: VecN; niter: number }
  | { solver: "ellipsoid"; vertices: Vertices; lines: Lines; objective: VecN; maxit: number; deepCuts: boolean; rayShoot: boolean; queryPoint: EllipsoidQueryPoint; initialScale: number };

type SolverWorkerRequest = SolverWorkerPayload & { id: number };

type SolverSuccess<S, R> = { id: number; solver: S; success: true; result: R };

// The engines emit one Float64Array per iterate. simplex/central are small and
// cross the worker boundary unchanged; pdhg/ipm/ellipsoid are packed into flat
// transferable buffers (resultPacking) and reach the client as one IterateResult.
export type SolverEngineSuccessResponse =
  | SolverSuccess<"ipm", ReturnType<typeof ipm>>
  | SolverSuccess<"simplex", SimplexResult>
  | SolverSuccess<"pdhg", ReturnType<typeof pdhg>>
  | SolverSuccess<"central", CentralPathResult>
  | SolverSuccess<"ellipsoid", EllipsoidResultData>;
export type SolverWorkerSuccessResponse = SolverSuccess<"simplex", SimplexResult> | SolverSuccess<"central", CentralPathResult> | SolverSuccess<PackedSolver, IterateResult>;

type SolverWorkerErrorResponse = { id: number; success: false; error: string };

export type SolverWorkerResponse = SolverWorkerSuccessResponse | SolverWorkerErrorResponse;

const DEFAULT_TOLERANCE = 1e-5;
const SOLVER_NAMES = { ipm: "IPM", simplex: "Simplex", pdhg: "PDHG", central: "Central Path", ellipsoid: "Ellipsoid" };

// Every engine reads its options by property, so spreading the request's
// remaining fields hands each one exactly the options it was built with (an
// absent startPoint/startVertex key reads as undefined either way).
function executeSolver({ id, ...data }: SolverWorkerRequest): SolverEngineSuccessResponse {
  try {
    switch (data.solver) {
      case "ipm": {
        const { solver, lines, objective, ...options } = data;
        return { id, solver, success: true, result: ipm(lines, objective, { eps_p: DEFAULT_TOLERANCE, eps_d: DEFAULT_TOLERANCE, eps_opt: DEFAULT_TOLERANCE, ...options }) };
      }
      case "simplex": {
        const { solver, lines, objective, ...options } = data;
        return { id, solver, success: true, result: simplex(lines, objective, { tol: DEFAULT_TOLERANCE, ...options }) };
      }
      case "pdhg": {
        const { solver, lines, objective, ...options } = data;
        return { id, solver, success: true, result: pdhg(lines, objective, { tol: DEFAULT_TOLERANCE, ...options }) };
      }
      case "central": {
        const { solver, vertices, lines, objective, ...options } = data;
        return { id, solver, success: true, result: centralPath(vertices, lines, objective, options) };
      }
      case "ellipsoid": {
        // The ellipsoid mode covers a family: the ellipsoid method proper, plus
        // the cutting-plane methods that localize with a polyhedron and differ
        // in which interior point they query. They return the same shape, so
        // everything downstream — packing, the log, the drawn ellipse — is shared.
        const { solver, vertices, lines, objective, deepCuts, queryPoint, ...options } = data;
        const shared = { tol: DEFAULT_TOLERANCE, ...options };
        return {
          id,
          solver,
          success: true,
          result: queryPoint === "ellipsoid" ? ellipsoid(vertices, lines, objective, { ...shared, deepCuts }) : cuttingPlane(vertices, lines, objective, { ...shared, queryPoint }),
        };
      }
    }
  } catch (error) {
    console.error(`Error in ${SOLVER_NAMES[data.solver]} solver:`, error);
    throw error;
  }
}

const ctx = self as unknown as Worker;

ctx.addEventListener("message", (event: MessageEvent<SolverWorkerRequest>) => {
  const data = event.data;
  if (!data) return;

  try {
    const { wire, transfer } = packSolverResponse(executeSolver(data), data.objective);
    ctx.postMessage(wire, transfer);
  } catch (error) {
    ctx.postMessage({ id: data.id, success: false, error: error instanceof Error ? error.message : String(error) });
  }
});
