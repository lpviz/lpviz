import { fmtCoordinates, fmtExp, fmtExpUnsigned, fmtIteration, logColumnWidths } from "@lpviz/solver-engine/fmt";
import { ellipsoidStride, localizingSetStride } from "@lpviz/solver-engine/localization";
import type { LogSection, NumericRow, SolverLog, SolverResult } from "@lpviz/solver-engine/result";
import type {
  PackedLogSection,
  PackedRows,
  ResultLogSection,
  ResultRowsView,
  SolverResultView,
  SolverWireResponse,
  SolverWireSuccess,
  SolverWorkerPayload,
  SolverWorkerResponse,
  VirtualResultRow,
} from "./types";

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
  const stride = rows[0]!.point.length;
  const cols: PackedRows = {
    coords: new Float64Array(count * stride),
    stride,
    objective: new Float64Array(count),
    infeasibility: new Float64Array(count),
    convergence: new Float64Array(count),
    restart: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    const row = rows[i]!;
    cols.coords.set(row.point, i * stride);
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
  const { convergence, phases, restartIndices, ellipsoids, localizingSetPoints, localizingSetOffsets } = result;
  const stride = request.objective.length;
  const { points, lift } = packIterations(result.iterations, stride, convergence ? liftOf(request.solver, convergence) : null);
  const log = packLog(result.log);
  const transfer: ArrayBufferLike[] = [points.buffer];
  if (lift) transfer.push(lift.buffer);
  for (const { rows } of log) {
    if (!Array.isArray(rows)) transfer.push(rows.coords.buffer, rows.objective.buffer, rows.infeasibility.buffer, rows.convergence.buffer, rows.restart.buffer);
  }
  if (ellipsoids) transfer.push(ellipsoids.buffer);
  // empty buffers are not worth a transfer, and skipping them keeps a
  // detached zero-length array from ever reaching the client
  if (localizingSetPoints?.length) transfer.push(localizingSetPoints.buffer);
  if (localizingSetOffsets?.length) transfer.push(localizingSetOffsets.buffer);
  // none of these arrays is ever backed by a SharedArrayBuffer
  return {
    wire: { id, success: true, iterations: points, stride, lift: lift ?? undefined, log, phases, restartIndices, ellipsoids, localizingSetPoints, localizingSetOffsets },
    transfer: transfer as ArrayBuffer[],
  };
}

// Row objects materialize lazily from the packed columns: only rows that
// actually render (a screenful) are ever built, instead of one object per
// iteration per solve.
function rowsView({ coords, stride, objective, infeasibility, convergence, restart }: PackedRows): ResultRowsView {
  const length = objective.length;
  return {
    length,
    at: (index) =>
      index >= 0 && index < length
        ? {
            iteration: index + 1,
            restart: restart[index] === 1,
            point: coords.subarray(index * stride, (index + 1) * stride),
            objective: objective[index]!,
            infeasibility: infeasibility[index]!,
            convergence: convergence[index]!,
          }
        : undefined,
  };
}

function unpackSection({ header, rows, notes, footer }: PackedLogSection): ResultLogSection {
  return { header, rows: Array.isArray(rows) ? rows : rowsView(rows), notes, footer };
}

export function unpackSolverResponse(wire: SolverWireResponse): SolverWorkerResponse {
  if (!wire.success) return wire;
  const { id, iterations, stride, lift, log, phases, restartIndices, ellipsoids, localizingSetPoints, localizingSetOffsets } = wire;
  const result: SolverResultView = {
    // the packed iterations are already a flat block in one transferred buffer, so the iterate
    // path is that buffer verbatim: no per-iterate object exists on this side
    iterations: { points: iterations, count: Math.floor(iterations.length / stride), stride, lift: lift ?? null },
    log: log.map(unpackSection),
    phases,
    restartIndices,
  };
  if (ellipsoids) {
    const shapeStride = ellipsoidStride(stride);
    result.ellipsoids = { data: ellipsoids, count: Math.floor(ellipsoids.length / shapeStride), stride: shapeStride };
  }
  // the offsets alone say how many sets there are; an empty run has none to draw
  if (localizingSetOffsets && localizingSetOffsets.length > 1) {
    result.localizingSets = { points: localizingSetPoints ?? new Float64Array(0), offsets: localizingSetOffsets, count: localizingSetOffsets.length - 1, stride: localizingSetStride(stride) };
  }
  return { id, success: true, result };
}

/** A row as the log prints it: a preformatted line, or a numeric row in the engine's columns. */
export function formatVirtualResultRow(row: VirtualResultRow): string {
  if (typeof row === "string") return row;
  const { coordinate, measure } = logColumnWidths(row.point.length);
  return `${fmtIteration(row.iteration, row.restart ? "r" : "")} ${fmtCoordinates(row.point, coordinate)} ${fmtExp(row.objective, measure, 1)} ${fmtExp(row.infeasibility, measure, 1)} ${fmtExpUnsigned(row.convergence, measure, 1)}`;
}
