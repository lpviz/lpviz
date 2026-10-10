import type { EllipsoidPath, EllipsoidQueryPoint, IteratePath, LazyList, LocalizingSetPath, ResultTextBlock } from "./solverState";
import type { Constraint, Vec } from "@lpviz/math/types";
import type { CentralPathOptions } from "@lpviz/solver-engine/centralPath";
import type { EllipsoidOptions } from "@lpviz/solver-engine/ellipsoid";
import type { IPMOptions } from "@lpviz/solver-engine/ipm";
import type { PDHGOptions } from "@lpviz/solver-engine/pdhg";
import type { LogSection, NumericRow } from "@lpviz/solver-engine/result";
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

// What crosses the worker boundary (see resultPacking): the iterates as one flat
// coordinate buffer plus their display lift, and the log with every numeric
// section's rows as typed columns. The buffers are transferred, not cloned.
export type PackedRows = {
  /** every row's coordinates, `stride` per row */
  coords: Float64Array;
  stride: number;
  objective: Float64Array;
  infeasibility: Float64Array;
  convergence: Float64Array;
  restart: Uint8Array;
};

export type PackedLogSection = Omit<LogSection, "rows"> & { rows: string[] | PackedRows };

export type SolverWireSuccess = {
  id: number;
  success: true;
  iterations: Float64Array;
  stride: number;
  lift?: Float64Array | undefined;
  log: PackedLogSection[];
  phases?: number[] | undefined;
  restartIndices?: number[] | undefined;
  ellipsoids?: Float64Array | undefined;
  localizingSetPoints?: Float64Array | undefined;
  localizingSetOffsets?: Uint32Array | undefined;
};

type SolverWorkerError = { id: number; success: false; error: string };

export type SolverWireResponse = SolverWireSuccess | SolverWorkerError;

// ---------- client ----------

export type VirtualResultRow = string | NumericRow;

// Rows materialize lazily through this view so that a 100k-iteration result
// never pays for building row objects that are not scrolled into view.
export type ResultRowsView = LazyList<VirtualResultRow>;

export type ResultLogSection = Omit<LogSection, "rows"> & { rows: ResultRowsView };

// A worker result once unpacked: the iterate path as the store keeps it, plus
// the log and whatever the solver drew.
export type SolverResultView = {
  iterations: IteratePath;
  log: ResultLogSection[];
  phases?: number[] | undefined;
  restartIndices?: number[] | undefined;
  ellipsoids?: EllipsoidPath | undefined;
  localizingSets?: LocalizingSetPath | undefined;
};

export type SolverWorkerSuccessResponse = { id: number; success: true; result: SolverResultView };

export type SolverWorkerResponse = SolverWorkerSuccessResponse | SolverWorkerError;

// ---------- render ----------

export type { ResultTextBlock } from "./solverState";

export interface VirtualResultPayload {
  type: "virtual";
  header: string;
  rows: ResultRowsView;
  footer?: string | undefined;
}

interface BlocksResultPayload {
  type: "blocks";
  blocks: ResultTextBlock[];
}

export type ResultRenderPayload = VirtualResultPayload | BlocksResultPayload;
