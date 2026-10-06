import type { EllipsoidPath, EllipsoidQueryPoint, IteratePath, LocalizingSetPath } from "@/features/core/store";
import type { Lines, VecN, Vertices } from "@lpviz/math/types";
import type { EllipsoidResultData } from "@lpviz/solver-engine/ellipsoid";
import type { ipm } from "@lpviz/solver-engine/ipm";
import type { pdhg } from "@lpviz/solver-engine/pdhg";
import type { EnteringRule, LeavingRule } from "@lpviz/solver-engine/simplex";

// ---------- request ----------

export type SolverWorkerPayload =
  | { solver: "ipm"; lines: Lines; objective: VecN; startPoint?: number[]; alphaMax: number; correctorThreshold: number; maxit: number }
  | { solver: "simplex"; lines: Lines; objective: VecN; startVertex?: number[]; dual: boolean; enteringRule: EnteringRule; leavingRule: LeavingRule }
  | { solver: "pdhg"; lines: Lines; objective: VecN; startPoint?: number[]; ineq: boolean; halpern: boolean; maxit: number; eta: number; tau: number; colorByBasis: boolean }
  | { solver: "central"; vertices: Vertices; lines: Lines; objective: VecN; niter: number }
  | { solver: "ellipsoid"; vertices: Vertices; lines: Lines; objective: VecN; maxit: number; deepCuts: boolean; rayShoot: boolean; queryPoint: EllipsoidQueryPoint; initialScale: number };

export type SolverWorkerRequest = SolverWorkerPayload & { id: number };

// ---------- engine results ----------

export interface SimplexResult {
  iterations: Float64Array[];
  phase1Iterations?: Float64Array[];
  logs: string[][];
  mode: "primal" | "dual";
  status?: "optimal" | "unbounded" | "infeasible";
}

export interface CentralPathResult {
  iterations: Float64Array[];
  logs: string[];
  tsolve: number;
}

type PackedSolver = "pdhg" | "ipm" | "ellipsoid";

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

// ---------- wire ----------

export type PackedRowsColumns = {
  x: Float64Array;
  y: Float64Array;
  objective: Float64Array;
  infeasibility: Float64Array;
  // epsilon for pdhg rows, mu for ipm rows, rho for ellipsoid rows
  extra: Float64Array;
  restart?: Uint8Array | undefined;
};

export type PackedSolverWire = {
  id: number;
  success: true;
  packed: true;
  solver: PackedSolver;
  // flat [x, y, z] per iteration, the display z baked in
  iterations: Float64Array;
  stride: number;
  rows: PackedRowsColumns;
  header: string;
  footer?: string | undefined;
  phases?: number[] | undefined;
  restartIndices?: number[] | undefined;
  // flat [cx, cy, p11, p12, p22] per iteration; ellipsoid method only
  ellipsoids?: Float64Array;
  // localizing polygons, only for the cutting-plane query points
  polygonPoints?: Float64Array;
  polygonOffsets?: Uint32Array;
};

export type PackedSolverWorkerResponse = (SolverWorkerResponse & { packed?: undefined }) | PackedSolverWire;

// ---------- client ----------

// One row shape for the three packed solvers; `extra` is each one's convergence
// measure (pdhg eps, ipm mu, ellipsoid rho), the trailing log column.
export type VirtualResultRow = string | { kind: PackedSolver; iteration: number; restart?: boolean; x: number; y: number; objective: number; infeasibility: number; extra: number };

// Rows materialize lazily through this view so that a 100k-iteration result
// never pays for building row objects that are not scrolled into view.
type ResultRowsView = {
  length: number;
  at(index: number): VirtualResultRow | undefined;
};

// What the client receives for pdhg/ipm/ellipsoid once unpacked: the iterates
// flat with the display z already baked in, plus whatever the solver drew.
export type IterateResult = {
  iterations: IteratePath;
  header: string;
  rows: ResultRowsView;
  footer?: string;
  phases?: number[] | undefined;
  restartIndices?: number[] | undefined;
  ellipsoids?: EllipsoidPath;
  localizingSets?: LocalizingSetPath | null;
};

export type SolverWorkerSuccessResponse = SolverSuccess<"simplex", SimplexResult> | SolverSuccess<"central", CentralPathResult> | SolverSuccess<PackedSolver, IterateResult>;

type SolverWorkerErrorResponse = { id: number; success: false; error: string };

export type SolverWorkerResponse = SolverWorkerSuccessResponse | SolverWorkerErrorResponse;

// ---------- render ----------

type ResultTextBlockClassName = "iterate-header" | "iterate-item" | "iterate-item-nohover" | "iterate-footer";

export type ResultTextBlock = {
  className: ResultTextBlockClassName;
  text: string;
  index?: number | undefined;
};

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
