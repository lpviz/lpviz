import type { EllipsoidQueryPoint } from "./solverSettings";
import type { EllipsoidPath, IteratePath, LazyList, LocalizingSetPath } from "./solverState";
import type { Constraint, Vec } from "@lpviz/math/types";
import type { CentralPathOptions } from "@lpviz/solver-engine/centralPath";
import type { EllipsoidOptions } from "@lpviz/solver-engine/ellipsoid";
import type { IPMOptions } from "@lpviz/solver-engine/ipm";
import type { PDHGOptions } from "@lpviz/solver-engine/pdhg";
import type { Iterates, LogSection, NumericRow, SolverResult } from "@lpviz/solver-engine/result";
import type { SimplexOptions } from "@lpviz/solver-engine/simplex";

// ---------- request ----------

// Each engine's own options, minus the tolerance the worker adds to all of them, on top of the
// problem: its constraints and objective, plus the drawn vertices for the engines that localize
// or start from the region. The central path's interior point is found from those vertices.
export type Problem = { constraints: Constraint[]; objective: Float64Array };
type DrawnProblem = Problem & { vertices: Vec[] };

export type SolverWorkerPayload =
  | ({ solver: "ipm" } & Problem & Omit<IPMOptions, "tol">)
  | ({ solver: "simplex" } & Problem & Omit<SimplexOptions, "tol">)
  | ({ solver: "pdhg" } & Problem & Omit<PDHGOptions, "tol">)
  | ({ solver: "central" } & DrawnProblem & Omit<CentralPathOptions, "interiorPoint">)
  | ({ solver: "ellipsoid" } & DrawnProblem & Omit<EllipsoidOptions, "tol"> & { queryPoint: EllipsoidQueryPoint });

export type SolverWorkerRequest = SolverWorkerPayload & { id: number };

// ---------- wire ----------

// What crosses the worker boundary (see resultPacking): the engine's result as it is, the flat
// iterate block, the log's numeric columns and what the solver drew, plus the iterates' display
// lift. The buffers are transferred, not cloned.
export type SolverWireSuccess = Pick<SolverResult, "iterates" | "log" | "phases" | "restartIndices" | "ellipsoids" | "localizingSetPoints" | "localizingSetOffsets"> & {
  id: number;
  success: true;
  lift?: Float64Array | undefined;
};

type SolverWorkerError = { id: number; success: false; error: string };

export type SolverWireResponse = SolverWireSuccess | SolverWorkerError;

// ---------- client ----------

export type VirtualResultRow = string | NumericRow;

// Rows materialize lazily, so a 100k-iteration result never pays for building
// row objects that are not scrolled into view.
export type LazyRows = LazyList<VirtualResultRow>;

export type ResultLogSection = Omit<LogSection, "rows"> & { rows: LazyRows };

// A worker result once unpacked: the iterate path as the store keeps it, plus
// the log and whatever the solver drew.
export type UnpackedSolverResult = Pick<SolverResult, "phases" | "restartIndices"> & {
  iterates: IteratePath & Iterates;
  log: ResultLogSection[];
  ellipsoids?: EllipsoidPath | undefined;
  localizingSets?: LocalizingSetPath | undefined;
};

export type SolverWorkerSuccessResponse = { id: number; success: true; result: UnpackedSolverResult };

export type SolverWorkerResponse = SolverWorkerSuccessResponse | SolverWorkerError;
