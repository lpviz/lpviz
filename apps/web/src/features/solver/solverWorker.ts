import type { LinesND, VecN, Vertices } from "@lpviz/math/types";
import { centralPath } from "@lpviz/solver-engine/centralPath";
import { cuttingPlane } from "@lpviz/solver-engine/cuttingPlane";
import { ellipsoid, type RegionVertices } from "@lpviz/solver-engine/ellipsoid";
import { ipm } from "@lpviz/solver-engine/ipm";
import { pdhg } from "@lpviz/solver-engine/pdhg";
import { simplex, type EnteringRule, type LeavingRule } from "@lpviz/solver-engine/simplex";
import { packSolverResponse } from "./resultPacking";

import type {
  EllipsoidPath,
  EllipsoidQueryPoint,
  IteratePath,
} from "@/features/core/store";
import type {
  CentralPathResult,
  EllipsoidResult,
  IPMResult,
  PDHGResult,
  SimplexResult,
} from "./solverService";

export type SolverWorkerPayload =
  | {
      solver: "ipm";
      lines: LinesND;
      objective: VecN;
      startPoint?: number[];
      alphaMax: number;
      correctorThreshold: number;
      maxit: number;
    }
  | {
      solver: "simplex";
      lines: LinesND;
      objective: VecN;
      startVertex?: number[];
      dual: boolean;
      enteringRule: EnteringRule;
      leavingRule: LeavingRule;
    }
  | {
      solver: "pdhg";
      lines: LinesND;
      objective: VecN;
      startPoint?: number[];
      ineq: boolean;
      halpern: boolean;
      maxit: number;
      eta: number;
      tau: number;
      colorByBasis: boolean;
    }
  | {
      solver: "central";
      vertices: Vertices;
      lines: LinesND;
      objective: VecN;
      niter: number;
      // 3-variable mode supplies its own strictly-interior start (the 2D
      // centroid/feasible-point search inside centralPath is planar only)
      interiorPoint?: number[];
    }
  | {
      solver: "ellipsoid";
      // the drawn region's extreme points, 2- or 3-dimensional
      vertices: RegionVertices;
      lines: LinesND;
      objective: VecN;
      maxit: number;
      deepCuts: boolean;
      rayShoot: boolean;
      queryPoint: EllipsoidQueryPoint;
      initialScale: number;
    };

type SolverWorkerRequest = SolverWorkerPayload & { id: number };

// `I` is the iterates representation for pdhg/ipm/ellipsoid: the worker emits
// one Float64Array per iterate (SolverEngineSuccessResponse), then
// packs/transfers so the client receives one flat IteratePath
// (SolverWorkerSuccessResponse). `E` is the same split for the ellipsoid
// method's per-iteration ellipses. simplex/central are small and pass through
// unchanged.
type SolverSuccessResponse<I, E> =
  | { id: number; solver: "ipm"; success: true; result: IPMResult<I> }
  | { id: number; solver: "simplex"; success: true; result: SimplexResult }
  | { id: number; solver: "pdhg"; success: true; result: PDHGResult<I> }
  | { id: number; solver: "central"; success: true; result: CentralPathResult }
  | {
      id: number;
      solver: "ellipsoid";
      success: true;
      result: EllipsoidResult<I, E>;
    };

export type SolverEngineSuccessResponse = SolverSuccessResponse<
  Float64Array[],
  Float64Array
>;
export type SolverWorkerSuccessResponse = SolverSuccessResponse<
  IteratePath,
  EllipsoidPath
>;

type SolverWorkerErrorResponse = {
  id: number;
  success: false;
  error: string;
};

export type SolverWorkerResponse = SolverWorkerSuccessResponse | SolverWorkerErrorResponse;

const DEFAULT_TOLERANCE = 1e-5;

interface BaseSolverOptions {
  tol: number;
  verbose: boolean;
}

const DEFAULT_BASE_OPTIONS: BaseSolverOptions = {
  tol: DEFAULT_TOLERANCE,
  verbose: false,
};

async function wrapSolverCall<T>(solverName: string, solverFunction: () => T | Promise<T>): Promise<T> {
  try {
    return await solverFunction();
  } catch (error) {
    console.error(`Error in ${solverName} solver:`, error);
    throw error;
  }
}

async function runCentralPath(vertices: Vertices, lines: LinesND, objective: VecN, niter: number, interiorPoint?: number[]) {
  return wrapSolverCall("Central Path", () => {
    const options = { ...DEFAULT_BASE_OPTIONS, niter, interiorPoint };
    return centralPath(vertices, lines, objective, options);
  });
}

async function runSimplex(
  lines: LinesND,
  objective: VecN,
  dual: boolean,
  enteringRule: EnteringRule,
  leavingRule: LeavingRule,
  startVertex?: number[],
) {
  return wrapSolverCall("Simplex", () => {
    const options = {
      tol: DEFAULT_TOLERANCE,
      verbose: false,
      dual,
      enteringRule,
      leavingRule,
      startVertex,
    };
    return simplex(lines, objective, options);
  });
}

async function runIPM(
  lines: LinesND,
  objective: VecN,
  alphamax: number,
  correctorThreshold: number,
  maxit: number,
  startPoint?: number[],
) {
  return wrapSolverCall("IPM", () => {
    const options = {
      ...DEFAULT_BASE_OPTIONS,
      eps_p: DEFAULT_TOLERANCE,
      eps_d: DEFAULT_TOLERANCE,
      eps_opt: DEFAULT_TOLERANCE,
      alphaMax: alphamax,
      correctorThreshold,
      maxit,
      startPoint,
    };
    return ipm(lines, objective, options);
  });
}

// The ellipsoid mode covers a family: the ellipsoid method proper, plus the
// cutting-plane methods that localize with a polyhedron and differ in which
// interior point they query. They return the same shape, so everything
// downstream — packing, the log, the drawn ellipse — is shared.
async function runEllipsoid(
  vertices: RegionVertices,
  lines: LinesND,
  objective: VecN,
  maxit: number,
  deepCuts: boolean,
  rayShoot: boolean,
  queryPoint: EllipsoidQueryPoint,
  initialScale: number,
) {
  return wrapSolverCall("Ellipsoid", () => {
    const shared = {
      ...DEFAULT_BASE_OPTIONS,
      maxit,
      rayShoot,
      initialScale,
    };
    return queryPoint === "ellipsoid"
      ? ellipsoid(vertices, lines, objective, {
          ...shared,
          deepCuts,
        })
      : cuttingPlane(vertices, lines, objective, { ...shared, queryPoint });
  });
}

async function runPDHG(
  lines: LinesND,
  objective: VecN,
  ineq: boolean,
  halpern: boolean,
  maxit: number,
  eta: number,
  tau: number,
  colorByBasis: boolean,
  startPoint?: number[],
) {
  return wrapSolverCall("PDHG", () => {
    const options = {
      ...DEFAULT_BASE_OPTIONS,
      ineq,
      halpern,
      maxit,
      eta,
      tau,
      colorByBasis,
      startPoint,
    };
    return pdhg(lines, objective, options);
  });
}

const ctx = self as unknown as Worker;

async function executeSolver(data: SolverWorkerRequest): Promise<SolverEngineSuccessResponse> {
  const { id } = data;
  if (data.solver === "ipm") {
    return {
      id,
      solver: "ipm",
      success: true,
      result: await runIPM(
        data.lines,
        data.objective,
        data.alphaMax,
        data.correctorThreshold,
        data.maxit,
        data.startPoint,
      ),
    };
  }
  if (data.solver === "simplex") {
    return {
      id,
      solver: "simplex",
      success: true,
      result: await runSimplex(
        data.lines,
        data.objective,
        data.dual,
        data.enteringRule,
        data.leavingRule,
        data.startVertex,
      ),
    };
  }
  if (data.solver === "pdhg") {
    return {
      id,
      solver: "pdhg",
      success: true,
      result: await runPDHG(
        data.lines,
        data.objective,
        data.ineq,
        data.halpern,
        data.maxit,
        data.eta,
        data.tau,
        data.colorByBasis,
        data.startPoint,
      ),
    };
  }
  if (data.solver === "ellipsoid") {
    return {
      id,
      solver: "ellipsoid",
      success: true,
      result: await runEllipsoid(
        data.vertices,
        data.lines,
        data.objective,
        data.maxit,
        data.deepCuts,
        data.rayShoot,
        data.queryPoint,
        data.initialScale,
      ),
    };
  }
  if (data.solver === "central") {
    return {
      id,
      solver: "central",
      success: true,
      result: await runCentralPath(data.vertices, data.lines, data.objective, data.niter, data.interiorPoint),
    };
  }
  const exhaustive: never = data;
  throw new Error(`Unsupported solver: ${JSON.stringify(exhaustive)}`);
}

ctx.addEventListener("message", async (event: MessageEvent<SolverWorkerRequest>) => {
  const data = event.data;
  if (!data) return;

  try {
    const { wire, transfer } = packSolverResponse(await executeSolver(data), data);
    ctx.postMessage(wire, transfer);
  } catch (error) {
    ctx.postMessage({
      id: data.id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
