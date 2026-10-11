import type { EllipsoidQueryPoint } from "./solverSettings";
import type { Constraint, Vec } from "@lpviz/math/types";
import type { CentralPathOptions } from "@lpviz/solver-engine/centralPath";
import type { EllipsoidOptions } from "@lpviz/solver-engine/ellipsoid";
import type { IPMOptions } from "@lpviz/solver-engine/ipm";
import type { PDHGOptions } from "@lpviz/solver-engine/pdhg";
import type { Iterates, LogSection, NumericRow, SolverResult } from "@lpviz/solver-engine/result";
import type { SimplexOptions } from "@lpviz/solver-engine/simplex";

// ---------- the store's shapes ----------

/** A line of the result panel: what it is (the panel decides how each kind looks), its text, and a row's iterate index. */
export type ResultTextBlock = {
  kind: "header" | "row" | "note" | "footer";
  text: string;
  index?: number | undefined;
};

// Result rows format lazily on access, so a 100k-iteration solve never formats rows that are not
// scrolled into view; plain arrays satisfy this shape.
export type LazyList<T> = {
  length: number;
  at(index: number): T | undefined;
};

// What the result panel shows: the usage hint before any solve, a phased run as text blocks, or a
// single run as a header, a virtual list of rows and a footer. `maxLineChars` is the widest line,
// which the panel fits its font to.
export type ResultView =
  { kind: "usage" } | { kind: "blocks"; blocks: ResultTextBlock[]; maxLineChars: number } | { kind: "virtual"; header: string; footer: string; rows: LazyList<ResultTextBlock>; maxLineChars: number };

// The engine's flat iterate block (iterate `i` at [i*stride .. i*stride+stride), `stride` the
// problem's dimension) with `lift[i]`, the height the 3D view raises iterate `i` above the floor
// (the solver's convergence measure, see resultPacking); null for solvers drawn flat. One array per
// solve, not one Float64Array per iterate: millions of live objects is what a major GC must mark.
export interface IteratePath extends Iterates {
  lift: Float64Array | null;
}

export const EMPTY_ITERATE_PATH: IteratePath = {
  points: new Float64Array(0),
  count: 0,
  stride: 2,
  lift: null,
};

// The ellipsoid family's per-iteration shape, parallel to the iterate path: element `i` is the
// center followed by the upper triangle of the symmetric shape matrix P of
// { x : (x - c)' P^-1 (x - c) <= 1 }, `stride` = ellipsoidStride(n) values ([cx, cy, p11, p12, p22]
// for two variables; see @lpviz/solver-engine/localization). Null for every other solver.
export interface EllipsoidPath {
  data: Float64Array;
  count: number;
  stride: number;
}

// The cutting-plane query points' localizing set per iteration: element `i` spans
// points[offsets[i] * stride .. offsets[i + 1] * stride), a closed polygon's [x, y] vertices for two
// variables (stride 2) and the half-spaces [a1..an, b] of the polyhedron otherwise (stride n + 1).
// Null for the ellipsoid method, whose localizing set is the ellipse already in EllipsoidPath.
export interface LocalizingSetPath {
  points: Float64Array;
  offsets: Uint32Array;
  count: number;
  stride: number;
}

// The display height of iterate `index`: a 3-variable problem's third coordinate, otherwise the
// solver's lift above the floor (zero for a solver drawn flat).
export function iterateHeight(path: IteratePath, index: number): number {
  return path.stride >= 3 ? path.points[index * path.stride + 2]! : (path.lift?.[index] ?? 0);
}

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
