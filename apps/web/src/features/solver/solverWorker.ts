import { centralPath } from "@lpviz/solver-engine/centralPath";
import { affineScaling } from "@lpviz/solver-engine/affineScaling";
import { hpr } from "@lpviz/solver-engine/hpr";
import { scs } from "@lpviz/solver-engine/scs";
import { crissCross } from "@lpviz/solver-engine/crissCross";
import { megiddo } from "@lpviz/solver-engine/megiddo";
import { seidel } from "@lpviz/solver-engine/seidel";
import { cuttingPlane } from "@lpviz/solver-engine/cuttingPlane";
import { ellipsoid } from "@lpviz/solver-engine/ellipsoid";
import { halo } from "@lpviz/solver-engine/halo";
import { hpdlp } from "@lpviz/solver-engine/hpdlp";
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
    // HALO-LP takes no step size; affine scaling and Karmarkar take alphaMax as their step fraction
    const { solver: _, constraints, objective, method, rhoN, homogeneous, ...options } = payload;
    const { maxit, startPoint, alphaMax } = options;
    if (method === "halo") return halo(constraints, objective, withTol({ maxit, startPoint, rhoN, homogeneous }));
    if (method === "affine" || method === "karmarkar") return affineScaling(constraints, objective, withTol({ maxit, startPoint, alphaMax, projective: method === "karmarkar" }));
    return ipm(constraints, objective, withTol({ ...options, homogeneous }));
  },
  simplex: (payload) => {
    const { solver: _, constraints, objective, ...options } = payload;
    return simplex(constraints, objective, withTol(options));
  },
  pdhg: (payload) => {
    // H-PDLP takes tau as its dual step sigma and always runs its own Halpern scheme on the inequality form
    const { solver: _, constraints, objective, method, hsd, nu, adaptiveWeight, ...options } = payload;
    // SCS and HPR-LP take only the cap and the start: their steps are their own
    if (method === "scs") return scs(constraints, objective, withTol({ maxit: options.maxit }));
    if (method === "hpr") return hpr(constraints, objective, withTol({ maxit: options.maxit, startPoint: options.startPoint }));
    return hsd ? hpdlp(constraints, objective, withTol({ ...options, sigma: options.tau, nu, adaptiveWeight })) : pdhg(constraints, objective, withTol(options));
  },
  // the active-set methods: criss-cross pivots on vertex bases, PDAS takes Newton steps on proximal
  // subproblems, Seidel inserts the rows in a random order, Megiddo prunes them by median tests; all return text rows and feasibility phases, like simplex
  activeSet: (payload) => {
    const { solver: _, constraints, objective, method, order, seed, maxit, startPoint, ...pdasOptions } = payload;
    if (method === "seidel") return seidel(constraints, objective, withTol({ seed }));
    if (method === "megiddo") return megiddo(constraints, objective, withTol({}));
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
