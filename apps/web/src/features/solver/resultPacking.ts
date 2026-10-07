import { ELLIPSOID_STRIDE } from "@lpviz/solver-engine/ellipsoid";
import type { LogSection, NumericRow, SolverLog, SolverResult } from "@lpviz/solver-engine/result";
import type { PackedLogSection, PackedRows, ResultLogSection, ResultRowsView, SolverResultView, SolverWireResponse, SolverWireSuccess, SolverWorkerPayload, SolverWorkerResponse } from "./types";

// The worker packs everything numeric into a few large typed arrays and transfers their buffers
// (zero copy): structured-cloning tens of thousands of small arrays and row objects costs tens of
// main-thread milliseconds per solve. The iterate buffer holds coordinates only; the height the 3D
// view lifts each iterate by (the solver's convergence measure: PDHG's `eps`, IPM's `mu`, the
// ellipsoid's `rho`, the central path's barrier term) travels as its own column. PDHG's residual is
// numerically tiny, so it is scaled to share IPM's visual range. Display tuning only, never fed
// back into the math.
const PDHG_EPS_Z_LIFT = 500;

function liftOf(solver: SolverWorkerPayload["solver"], convergence: number[]): (index: number) => number {
  return solver === "pdhg" ? (index) => PDHG_EPS_Z_LIFT * (convergence[index] ?? 0) : (index) => convergence[index] ?? 0;
}

// One flat buffer of coordinates, `stride` (the problem's dimension) per iterate, and the lift per
// iterate for the solvers that have one.
function packIterations(entries: Float64Array[], stride: number, lift: ((index: number) => number) | null): { points: Float64Array; lift: Float64Array | null } {
  const points = new Float64Array(entries.length * stride);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    for (let k = 0; k < stride; k++) points[i * stride + k] = entry[k] ?? 0;
  }
  const lifts = lift ? new Float64Array(entries.length) : null;
  if (lifts && lift) for (let i = 0; i < entries.length; i++) lifts[i] = lift(i);
  return { points, lift: lifts };
}

// Row i of a numeric section is iterate i + 1 in every engine, so the iteration
// column is regenerated on the client instead of transferred.
function packRows(rows: NumericRow[]): PackedRows {
  const count = rows.length;
  const cols: PackedRows = {
    x: new Float64Array(count),
    y: new Float64Array(count),
    objective: new Float64Array(count),
    infeasibility: new Float64Array(count),
    convergence: new Float64Array(count),
    restart: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    const row = rows[i]!;
    cols.x[i] = row.x;
    cols.y[i] = row.y;
    cols.objective[i] = row.objective;
    cols.infeasibility[i] = row.infeasibility;
    cols.convergence[i] = row.convergence;
    if (row.restart) cols.restart[i] = 1;
  }
  return cols;
}

// an empty section passes through as the empty array: nothing to pack
const isNumericRows = (rows: LogSection["rows"]): rows is NumericRow[] => rows.length > 0 && typeof rows[0] !== "string";

function packLog(log: SolverLog): PackedLogSection[] {
  return log.map(({ header, rows, notes, footer }: LogSection) => ({ header, rows: isNumericRows(rows) ? packRows(rows) : rows, notes, footer }));
}

export function packSolverResponse(id: number, request: SolverWorkerPayload, result: SolverResult): { wire: SolverWireSuccess; transfer: ArrayBuffer[] } {
  const { convergence, phases, restartIndices, ellipsoids, polygonPoints, polygonOffsets } = result;
  const stride = request.objective.length;
  const { points, lift } = packIterations(result.iterations, stride, convergence ? liftOf(request.solver, convergence) : null);
  const log = packLog(result.log);
  const transfer: ArrayBufferLike[] = [points.buffer];
  if (lift) transfer.push(lift.buffer);
  for (const { rows } of log) {
    if (!Array.isArray(rows)) transfer.push(rows.x.buffer, rows.y.buffer, rows.objective.buffer, rows.infeasibility.buffer, rows.convergence.buffer, rows.restart.buffer);
  }
  if (ellipsoids) transfer.push(ellipsoids.buffer);
  // empty buffers are not worth a transfer, and skipping them keeps a
  // detached zero-length array from ever reaching the client
  if (polygonPoints?.length) transfer.push(polygonPoints.buffer);
  if (polygonOffsets?.length) transfer.push(polygonOffsets.buffer);
  // none of these arrays is ever backed by a SharedArrayBuffer
  return {
    wire: { id, success: true, iterations: points, stride, lift: lift ?? undefined, log, phases, restartIndices, ellipsoids, polygonPoints, polygonOffsets },
    transfer: transfer as ArrayBuffer[],
  };
}

// Row objects materialize lazily from the packed columns: only rows that
// actually render (a screenful) are ever built, instead of one object per
// iteration per solve.
function rowsView({ x, y, objective, infeasibility, convergence, restart }: PackedRows): ResultRowsView {
  return {
    length: x.length,
    at: (index) =>
      index >= 0 && index < x.length
        ? { iteration: index + 1, restart: restart[index] === 1, x: x[index]!, y: y[index]!, objective: objective[index]!, infeasibility: infeasibility[index]!, convergence: convergence[index]! }
        : undefined,
  };
}

function unpackSection({ header, rows, notes, footer }: PackedLogSection): ResultLogSection {
  return { header, rows: Array.isArray(rows) ? rows : rowsView(rows), notes, footer };
}

export function unpackSolverResponse(wire: SolverWireResponse): SolverWorkerResponse {
  if (!wire.success) return wire;
  const { id, iterations, stride, lift, log, phases, restartIndices, ellipsoids, polygonPoints, polygonOffsets } = wire;
  const result: SolverResultView = {
    // The packed iterations are already a flat block in one transferred buffer, so the iterate
    // path is that buffer verbatim — no per-iterate views are materialized (their allocation,
    // ~100k objects per solve at high maxit, was the dominant main-thread GC cost during rotation).
    iterations: { points: iterations, count: Math.floor(iterations.length / stride), stride, lift: lift ?? null },
    log: log.map(unpackSection),
    phases,
    restartIndices,
  };
  if (ellipsoids) result.ellipsoids = { data: ellipsoids, count: Math.floor(ellipsoids.length / ELLIPSOID_STRIDE), stride: ELLIPSOID_STRIDE };
  if (polygonOffsets) result.localizingSets = polygonOffsets.length > 1 ? { points: polygonPoints ?? new Float64Array(0), offsets: polygonOffsets, count: polygonOffsets.length - 1 } : null;
  return { id, success: true, result };
}
