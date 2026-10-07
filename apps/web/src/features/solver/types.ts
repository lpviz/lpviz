import type { EllipsoidPath, EllipsoidQueryPoint, IteratePath, LocalizingSetPath, ResultTextBlock } from "./solverState";
import type { Lines, VecN, Vertices } from "@lpviz/math/types";
import type { NumericRow } from "@lpviz/solver-engine/result";
import type { EnteringRule, LeavingRule } from "@lpviz/solver-engine/simplex";

// ---------- request ----------

export type SolverWorkerPayload =
  | { solver: "ipm"; lines: Lines; objective: VecN; startPoint?: number[]; alphaMax: number; correctorThreshold: number; maxit: number }
  | { solver: "simplex"; lines: Lines; objective: VecN; startVertex?: number[]; dual: boolean; enteringRule: EnteringRule; leavingRule: LeavingRule }
  | { solver: "pdhg"; lines: Lines; objective: VecN; startPoint?: number[]; ineq: boolean; halpern: boolean; maxit: number; eta: number; tau: number; colorByBasis: boolean }
  | { solver: "central"; vertices: Vertices; lines: Lines; objective: VecN; niter: number; interiorPoint?: number[] }
  | { solver: "ellipsoid"; vertices: Vertices; lines: Lines; objective: VecN; maxit: number; deepCuts: boolean; rayShoot: boolean; queryPoint: EllipsoidQueryPoint; initialScale: number };

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

export type PackedLogSection = {
  header: string;
  rows: string[] | PackedRows;
  notes?: string[] | undefined;
  footer?: string | undefined;
};

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
  polygonPoints?: Float64Array | undefined;
  polygonOffsets?: Uint32Array | undefined;
};

type SolverWorkerError = { id: number; success: false; error: string };

export type SolverWireResponse = SolverWireSuccess | SolverWorkerError;

// ---------- client ----------

export type VirtualResultRow = string | NumericRow;

// Rows materialize lazily through this view so that a 100k-iteration result
// never pays for building row objects that are not scrolled into view.
export type ResultRowsView = {
  length: number;
  at(index: number): VirtualResultRow | undefined;
};

export type ResultLogSection = {
  header: string;
  rows: ResultRowsView;
  notes?: string[] | undefined;
  footer?: string | undefined;
};

// A worker result once unpacked: the iterate path as the store keeps it, plus
// the log and whatever the solver drew.
export type SolverResultView = {
  iterations: IteratePath;
  log: ResultLogSection[];
  phases?: number[] | undefined;
  restartIndices?: number[] | undefined;
  ellipsoids?: EllipsoidPath | undefined;
  localizingSets?: LocalizingSetPath | null | undefined;
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
