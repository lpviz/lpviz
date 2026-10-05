import { ELLIPSOID_STRIDE } from "@lpviz/solver-engine/ellipsoid";
import type { VecN } from "@lpviz/math/types";
import type { IterateResult, PackedSolver } from "./solverService";
import type { SolverEngineSuccessResponse, SolverWorkerResponse } from "./solverWorker";

// Solver results at high maxit are tens of thousands of small Float64Arrays
// plus as many row objects; structured-cloning that shape costs tens of
// milliseconds of main-thread time per solve (per rotation step). Instead the
// worker packs everything numeric into a few large typed arrays and transfers
// their buffers (zero copy): the client takes the iterations buffer as one
// flat IteratePath and materializes row objects lazily on access. The display
// z (objective-dependent) is baked into a third component here, on the worker,
// so the client never needs the per-iterate mapping pass.
//
// The baked z is `objective·point + convergenceLift`: iterates sit at their
// objective value and are lifted above the optimal surface by how far they are
// from convergence, so the path visibly descends as it converges. The lift
// uses each solver's natural convergence measure — PDHG's residual `eps`,
// IPM's barrier `mu`, the ellipsoid's `rho`. PDHG's residual is numerically
// tiny, so it is scaled to share IPM's visual range; this factor is display
// tuning only and never feeds back into the math.
const PDHG_EPS_Z_LIFT = 500;

type PackedRowsColumns = {
  x: Float64Array;
  y: Float64Array;
  objective: Float64Array;
  infeasibility: Float64Array;
  // epsilon for pdhg rows, mu for ipm rows, rho for ellipsoid rows
  extra: Float64Array;
  restart?: Uint8Array;
};

type PackedFields = {
  iterations: Float64Array[];
  lift: (index: number) => number;
  rows: PackedRowsColumns;
  header: string;
  footer?: string;
  phases?: number[];
  restartIndices?: number[];
  // flat [cx, cy, p11, p12, p22] per iteration; ellipsoid method only
  ellipsoids?: Float64Array;
  // localizing polygons, only for the cutting-plane query points
  polygonPoints?: Float64Array;
  polygonOffsets?: Uint32Array;
};

export type PackedSolverWorkerResponse =
  | (SolverWorkerResponse & { packed?: undefined })
  | (Omit<PackedFields, "iterations" | "lift"> & { id: number; success: true; packed: true; solver: PackedSolver; iterations: Float64Array; stride: number });

function packRows<R extends { x: number; y: number; objective: number; infeasibility: number; restart?: boolean }>(rows: R[], extraOf: (row: R) => number, withRestart: boolean): PackedRowsColumns {
  const count = rows.length;
  const cols: PackedRowsColumns = {
    x: new Float64Array(count),
    y: new Float64Array(count),
    objective: new Float64Array(count),
    infeasibility: new Float64Array(count),
    extra: new Float64Array(count),
    restart: withRestart ? new Uint8Array(count) : undefined,
  };
  for (let i = 0; i < count; i++) {
    const row = rows[i]!;
    cols.x[i] = row.x;
    cols.y[i] = row.y;
    cols.objective[i] = row.objective;
    cols.infeasibility[i] = row.infeasibility;
    cols.extra[i] = extraOf(row);
    if (cols.restart && row.restart) cols.restart[i] = 1;
  }
  return cols;
}

// Which engine fields feed the shared wire shape: the iterates, the per-iterate
// convergence measure (lifting the display z and filling the trailing log
// column), and whatever kind-specific extras ride along.
function packedFields(response: Exclude<SolverEngineSuccessResponse, { solver: "simplex" | "central" }>): PackedFields {
  switch (response.solver) {
    case "pdhg": {
      const { iterations, eps, rows, header, footer, phases, restartIndices } = response.result;
      return { iterations, lift: (index) => PDHG_EPS_Z_LIFT * (eps?.[index] ?? 0), rows: packRows(rows, (row) => row.epsilon, true), header, footer, phases, restartIndices };
    }
    case "ipm": {
      const { x, mu, rows, header, footer } = response.result.iterates.solution;
      return { iterations: x, lift: (index) => mu?.[index] ?? 0, rows: packRows(rows, (row) => row.mu, false), header, footer };
    }
    case "ellipsoid": {
      const { iterations, rho, rows, header, footer, ellipsoids, polygonPoints, polygonOffsets } = response.result;
      return { iterations, lift: (index) => rho?.[index] ?? 0, rows: packRows(rows, (row) => row.rho, false), header, footer, ellipsoids, polygonPoints, polygonOffsets };
    }
  }
}

export function packSolverResponse(response: SolverEngineSuccessResponse, objective: VecN): { wire: PackedSolverWorkerResponse; transfer: ArrayBuffer[] } {
  // simplex and central path results are small (few iterations / log strings)
  if (response.solver === "simplex" || response.solver === "central") {
    return { wire: response, transfer: [] };
  }

  const { iterations: entries, lift, ...fields } = packedFields(response);
  const iterations = new Float64Array(entries.length * 3);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    iterations[i * 3] = entry[0] ?? 0;
    iterations[i * 3 + 1] = entry[1] ?? 0;
    iterations[i * 3 + 2] = objective[0]! * entry[0]! + objective[1]! * entry[1]! + lift(i);
  }
  const { rows, ellipsoids, polygonPoints, polygonOffsets } = fields;
  return {
    wire: { id: response.id, success: true, packed: true, solver: response.solver, iterations, stride: 3, ...fields },
    transfer: [
      iterations.buffer,
      rows.x.buffer,
      rows.y.buffer,
      rows.objective.buffer,
      rows.infeasibility.buffer,
      rows.extra.buffer,
      ...(rows.restart ? [rows.restart.buffer] : []),
      ...(ellipsoids ? [ellipsoids.buffer] : []),
      // empty buffers are not worth a transfer, and skipping them keeps a
      // detached zero-length array from ever reaching the client
      ...(polygonPoints?.length ? [polygonPoints.buffer] : []),
      ...(polygonOffsets?.length ? [polygonOffsets.buffer] : []),
    ] as ArrayBuffer[],
  };
}

export function unpackSolverResponse(wire: PackedSolverWorkerResponse): SolverWorkerResponse {
  if (!("packed" in wire) || !wire.packed) {
    return wire;
  }

  const { solver, iterations, stride, header, footer, phases, restartIndices } = wire;
  const { x, y, objective, infeasibility, extra, restart } = wire.rows;
  const result: IterateResult = {
    // The packed iterations are already a flat stride-3 block (z baked) in one
    // transferred buffer, so the iterate path is that buffer verbatim — no
    // per-iterate views are materialized (their allocation, ~100k objects per
    // solve at high maxit, was the dominant main-thread GC cost during rotation).
    iterations: { points: iterations, count: Math.floor(iterations.length / stride), stride },
    header,
    // Row objects materialize lazily from the packed columns: only rows that
    // actually render (a screenful) are ever built, instead of one object per
    // iteration per solve.
    rows: {
      length: x.length,
      at: (index: number) =>
        index >= 0 && index < x.length
          ? {
              kind: solver,
              iteration: index + 1,
              restart: restart ? restart[index] === 1 : false,
              x: x[index]!,
              y: y[index]!,
              objective: objective[index]!,
              infeasibility: infeasibility[index]!,
              extra: extra[index]!,
            }
          : undefined,
    },
    footer: footer ?? "",
    phases,
    restartIndices,
  };
  if (solver === "ellipsoid") {
    const ellipsoids = wire.ellipsoids ?? new Float64Array(0);
    const polygonPoints = wire.polygonPoints ?? new Float64Array(0);
    const polygonOffsets = wire.polygonOffsets ?? new Uint32Array(1);
    result.ellipsoids = { data: ellipsoids, count: Math.floor(ellipsoids.length / ELLIPSOID_STRIDE), stride: ELLIPSOID_STRIDE };
    result.localizingSets = polygonOffsets.length > 1 ? { points: polygonPoints, offsets: polygonOffsets, count: polygonOffsets.length - 1 } : null;
  }
  return { id: wire.id, solver, success: true, result };
}
