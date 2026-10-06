import { centralPath } from "@lpviz/solver-engine/centralPath";
import { cuttingPlane } from "@lpviz/solver-engine/cuttingPlane";
import { ellipsoid } from "@lpviz/solver-engine/ellipsoid";
import { ipm } from "@lpviz/solver-engine/ipm";
import { pdhg } from "@lpviz/solver-engine/pdhg";
import type { SolverResult } from "@lpviz/solver-engine/result";
import { simplex } from "@lpviz/solver-engine/simplex";
import { packSolverResponse } from "./resultPacking";
import type { SolverWorkerPayload, SolverWorkerRequest } from "./types";

const DEFAULT_TOLERANCE = 1e-5;
const SOLVER_NAMES = { ipm: "IPM", simplex: "Simplex", pdhg: "PDHG", central: "Central Path", ellipsoid: "Ellipsoid" };

// Every engine reads its options by property, so spreading the request's
// remaining fields hands each one exactly the options it was built with (an
// absent startPoint/startVertex key reads as undefined either way).
function executeSolver(data: SolverWorkerPayload): SolverResult {
  try {
    switch (data.solver) {
      case "ipm": {
        const { solver: _, lines, objective, ...options } = data;
        return ipm(lines, objective, { eps_p: DEFAULT_TOLERANCE, eps_d: DEFAULT_TOLERANCE, eps_opt: DEFAULT_TOLERANCE, ...options });
      }
      case "simplex": {
        const { solver: _, lines, objective, ...options } = data;
        return simplex(lines, objective, { tol: DEFAULT_TOLERANCE, ...options });
      }
      case "pdhg": {
        const { solver: _, lines, objective, ...options } = data;
        return pdhg(lines, objective, { tol: DEFAULT_TOLERANCE, ...options });
      }
      case "central": {
        const { solver: _, vertices, lines, objective, ...options } = data;
        return centralPath(vertices, lines, objective, options);
      }
      case "ellipsoid": {
        // The ellipsoid mode covers a family: the ellipsoid method proper, plus
        // the cutting-plane methods that localize with a polyhedron and differ
        // in which interior point they query. They return the same shape, so
        // everything downstream — packing, the log, the drawn ellipse — is shared.
        const { solver: _, vertices, lines, objective, deepCuts, queryPoint, ...options } = data;
        const shared = { tol: DEFAULT_TOLERANCE, ...options };
        return queryPoint === "ellipsoid" ? ellipsoid(vertices, lines, objective, { ...shared, deepCuts }) : cuttingPlane(vertices, lines, objective, { ...shared, queryPoint });
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
    const { id, ...payload } = data;
    const { wire, transfer } = packSolverResponse(id, payload, executeSolver(payload));
    ctx.postMessage(wire, transfer);
  } catch (error) {
    ctx.postMessage({ id: data.id, success: false, error: error instanceof Error ? error.message : String(error) });
  }
});
