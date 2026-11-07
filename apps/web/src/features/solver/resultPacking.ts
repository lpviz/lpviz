import { formatNumericRow } from "@lpviz/solver-engine/fmt";
import type { Iterates, LogSection, NumericRows, SolverResult } from "@lpviz/solver-engine/result";
import type { LazyRows, ResultLogSection, SolverWireResponse, SolverWireSuccess, SolverWorkerPayload, SolverWorkerResponse, VirtualResultRow } from "./types";

// The worker's reply is the engine's result with its buffers transferred (zero copy): the flat
// iterate block, the log's numeric columns and whatever the solver drew. No per-iterate object
// exists on either side; structured-cloning tens of thousands of them cost tens of main-thread
// milliseconds per solve. The height the 3D view lifts each iterate by is the solver's convergence
// measure (PDHG's `eps`, IPM's `mu`, the ellipsoid's `rho`, the central path's barrier term);
// PDHG's is numerically tiny, so it is scaled to share IPM's visual range. Display tuning only,
// never fed back into the math.
const PDHG_EPS_Z_LIFT = 500;
// HALO-LP's mu (and the homogeneous IPM's mu/tau^2, and the primal methods' gap) drops by orders of magnitude per step, so a linear lift is one tall start and
// a flat path. It is lifted by its order of magnitude above the run's smallest mu instead, so the
// last iterate of a converged run sits on the floor, with mu = 1 at PDHG's lifted start (eps = 1):
// every power of ten is one even step down. At least one decade separates the two.
export function haloLift(mu: Float64Array): Float64Array {
  let smallest = Infinity;
  for (const value of mu) if (value > 0) smallest = Math.min(smallest, value);
  const floor = Number.isFinite(smallest) ? Math.min(Math.log10(smallest), -1) : -1;
  return Float64Array.from(mu, (value) => (value > 0 ? (PDHG_EPS_Z_LIFT * Math.max(0, Math.log10(value) - floor)) / -floor : 0));
}

const liftOf = (request: SolverWorkerPayload, convergence: Float64Array | undefined): Float64Array | undefined => {
  if (!convergence) return undefined;
  if (request.solver === "pdhg") return Float64Array.from(convergence, (eps) => PDHG_EPS_Z_LIFT * eps);
  if (request.solver === "ipm" && (request.method !== "mpc" || request.homogeneous)) return haloLift(convergence);
  return convergence;
};

// an empty section passes through as the empty array: nothing to format
const isNumericRows = (rows: LogSection["rows"]): rows is NumericRows => !Array.isArray(rows);

export function packSolverResponse(id: number, request: SolverWorkerPayload, result: SolverResult): { wire: SolverWireSuccess; transfer: ArrayBuffer[] } {
  const { iterates, convergence, log, phases, restartIndices, ellipsoids, localizingSets } = result;
  const lift = liftOf(request, convergence);
  // a buffer transfers once however many views share it (the lift is the convergence column for
  // every solver but PDHG and the IPM variants); an empty one is not worth a transfer, and skipping it keeps a detached
  // zero-length array from ever reaching the client
  const buffers = new Set<ArrayBufferLike>();
  const transfer = (array: Float64Array | Uint8Array | Uint32Array | undefined) => {
    if (array?.length) buffers.add(array.buffer);
  };
  transfer(iterates.points);
  transfer(lift);
  for (const { rows } of log) {
    if (isNumericRows(rows)) for (const column of Object.values(rows)) transfer(column);
  }
  transfer(ellipsoids?.data);
  transfer(localizingSets?.points);
  transfer(localizingSets?.offsets);
  // none of these arrays is ever backed by a SharedArrayBuffer
  return { wire: { id, success: true, iterates, lift, log, phases, restartIndices, ellipsoids, localizingSets }, transfer: [...buffers] as ArrayBuffer[] };
}

// Row objects materialize lazily from the columns: only rows that actually render (a screenful)
// are ever built, instead of one object per iteration per solve.
function lazyRows({ objective, infeasibility, convergence, restart }: NumericRows, { points, stride }: Iterates): LazyRows {
  const length = objective.length;
  return {
    length,
    at: (index) =>
      index >= 0 && index < length
        ? {
            iteration: index + 1,
            restart: restart[index] === 1,
            point: points.subarray(index * stride, (index + 1) * stride),
            objective: objective[index]!,
            infeasibility: infeasibility[index]!,
            convergence: convergence[index]!,
          }
        : undefined,
  };
}

function unpackSection({ header, rows, notes, footer }: LogSection, iterates: Iterates): ResultLogSection {
  return { header, rows: isNumericRows(rows) ? lazyRows(rows, iterates) : rows, notes, footer };
}

export function unpackSolverResponse(wire: SolverWireResponse): SolverWorkerResponse {
  if (!wire.success) return wire;
  const { id, iterates, lift, log, phases, restartIndices, ellipsoids, localizingSets } = wire;
  return {
    id,
    success: true,
    result: { iterates: { ...iterates, lift: lift ?? null }, log: log.map((section) => unpackSection(section, iterates)), phases, restartIndices, ellipsoids, localizingSets },
  };
}

/** A row as the log prints it: a preformatted line, or a numeric row in the engine's columns. */
export const formatVirtualResultRow = (row: VirtualResultRow): string => (typeof row === "string" ? row : formatNumericRow(row));
