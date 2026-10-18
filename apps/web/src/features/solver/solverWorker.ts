import { centralPath } from "@lpviz/solver-engine/centralPath";
import { crissCross } from "@lpviz/solver-engine/crissCross";
import { cuttingPlane } from "@lpviz/solver-engine/cuttingPlane";
import { ellipsoid } from "@lpviz/solver-engine/ellipsoid";
import { ipm } from "@lpviz/solver-engine/ipm";
import { pdas } from "@lpviz/solver-engine/pdas";
import { pdhg } from "@lpviz/solver-engine/pdhg";
import type { SolverResult } from "@lpviz/solver-engine/result";
import { simplex } from "@lpviz/solver-engine/simplex";
import { SOLVER_LABELS, type SolverMode } from "./solverSettings";
import { packSolverResponse } from "./resultPacking";
import type { SolverWorkerPayload, SolverWorkerRequest } from "./types";

const DEFAULT_TOLERANCE = 1e-5;
const withTol = <O extends object>(options: O) => ({ tol: DEFAULT_TOLERANCE, ...options });

// Each mode's engine on its request, which is the engine's options minus the shared tolerance
// (see SolverWorkerPayload), so the rest of it spreads straight in.
const RUN: { [K in SolverMode]: (payload: Extract<SolverWorkerPayload, { solver: K }>) => SolverResult } = {
  ipm: (payload) => {
    const { solver: _, constraints, objective, ...options } = payload;
    return ipm(constraints, objective, withTol(options));
  },
  simplex: (payload) => {
    const { solver: _, constraints, objective, ...options } = payload;
    return simplex(constraints, objective, withTol(options));
  },
  pdhg: (payload) => {
    const { solver: _, constraints, objective, ...options } = payload;
    return pdhg(constraints, objective, withTol(options));
  },
  // the active-set methods: criss-cross pivots on vertex bases, PDAS takes Newton steps on proximal
  // subproblems; both return text rows and feasibility phases, like simplex
  activeSet: (payload) => {
    const { solver: _, constraints, objective, method, order, maxit, startPoint, ...pdasOptions } = payload;
    return method === "crissCross"
      ? crissCross(constraints, objective, withTol({ maxit, order, startVertex: startPoint }))
      : pdas(constraints, objective, withTol({ ...pdasOptions, maxit, startPoint }));
  },
  central: (payload) => {
    const { solver: _, vertices, constraints, objective, ...options } = payload;
    return centralPath(vertices, constraints, objective, options);
  },
  // The ellipsoid mode covers a family: the ellipsoid method proper, plus the cutting-plane methods
  // that localize with a polyhedron and differ in which interior point they query. They return the
  // same shape, so everything downstream (packing, the log, the drawn ellipse) is shared.
  ellipsoid: (payload) => {
    const { solver: _, vertices, constraints, objective, deepCuts, queryPoint, ...options } = payload;
    return queryPoint === "ellipsoid"
      ? ellipsoid(vertices, constraints, objective, { ...withTol(options), deepCuts })
      : cuttingPlane(vertices, constraints, objective, { ...withTol(options), queryPoint });
  },
};

function executeSolver(data: SolverWorkerPayload): SolverResult {
  try {
    // the table's entry is the one for the discriminant, which an index cannot tell TypeScript
    return (RUN[data.solver] as (payload: SolverWorkerPayload) => SolverResult)(data);
  } catch (error) {
    console.error(`Error in ${SOLVER_LABELS[data.solver]} solver:`, error);
    throw error;
  }
}

const ctx = self as unknown as Worker;

ctx.addEventListener("message", (event: MessageEvent<SolverWorkerRequest>) => {
  const data = event.data;
  if (!data) return;

  try {
    const { id, ...payload } = data;
    const { wire, transfer } = packSolverResponse(id, payload, executeSolver(payload));
    ctx.postMessage(wire, transfer);
  } catch (error) {
    ctx.postMessage({ id: data.id, success: false, error: error instanceof Error ? error.message : String(error) });
  }
});
