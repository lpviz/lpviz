import type { IteratePath } from "@/features/core/store";
import type { VecN } from "@lpviz/math/types";
import type { SolverEngineSuccessResponse, SolverWorkerPayload, SolverWorkerResponse } from "./solverWorker";

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
// IPM's barrier `mu`. PDHG's residual is numerically tiny, so it is scaled to
// share IPM's visual range; this factor is display tuning only and never feeds
// back into the math.
const PDHG_EPS_Z_LIFT = 500;

type PackedRowsColumns = {
  x: Float64Array;
  y: Float64Array;
  // present only for 3-variable problems
  z?: Float64Array;
  objective: Float64Array;
  infeasibility: Float64Array;
  // epsilon for pdhg rows, mu for ipm rows, rho for ellipsoid rows
  extra: Float64Array;
  restart?: Uint8Array;
};

export type PackedSolverWorkerResponse =
  | (SolverWorkerResponse & { packed?: undefined })
  | {
      id: number;
      success: true;
      packed: true;
      solver: "pdhg" | "ipm" | "ellipsoid";
      iterations: Float64Array;
      stride: number;
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
      // see EllipsoidResultData: both depend on the variable count
      polygonStride?: number;
      ellipsoidStride?: number;
    };

function packIterations(entries: Float64Array[], zOf: (entry: Float64Array, index: number) => number): Float64Array {
  const packed = new Float64Array(entries.length * 3);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const base = i * 3;
    packed[base] = entry[0] ?? 0;
    packed[base + 1] = entry[1] ?? 0;
    packed[base + 2] = zOf(entry, i);
  }
  return packed;
}

// The packed iterations are already a flat stride-3 block (z baked) in one
// transferred buffer, so the iterate path is that buffer verbatim — no
// per-iterate views are materialized (their allocation, ~100k objects per solve
// at high maxit, was the dominant main-thread GC cost during rotation).
function unpackIteratePath(packed: Float64Array, stride: number): IteratePath {
  return { points: packed, count: Math.floor(packed.length / stride), stride };
}

function packRows(
  rows: {
    length: number;
    at(index: number):
      | {
          x: number;
          y: number;
          z?: number;
          objective: number;
          infeasibility: number;
          restart?: boolean;
        }
      | undefined;
  },
  extraOf: (row: never) => number,
  withRestart: boolean,
  withZ: boolean,
): PackedRowsColumns {
  const count = rows.length;
  const cols: PackedRowsColumns = {
    x: new Float64Array(count),
    y: new Float64Array(count),
    z: withZ ? new Float64Array(count) : undefined,
    objective: new Float64Array(count),
    infeasibility: new Float64Array(count),
    extra: new Float64Array(count),
    restart: withRestart ? new Uint8Array(count) : undefined,
  };
  for (let i = 0; i < count; i++) {
    const row = rows.at(i)!;
    cols.x[i] = row.x;
    cols.y[i] = row.y;
    if (cols.z) cols.z[i] = row.z ?? 0;
    cols.objective[i] = row.objective;
    cols.infeasibility[i] = row.infeasibility;
    cols.extra[i] = extraOf(row as never);
    if (cols.restart && row.restart) cols.restart[i] = 1;
  }
  return cols;
}

export function packSolverResponse(response: SolverEngineSuccessResponse, request: SolverWorkerPayload): { wire: PackedSolverWorkerResponse; transfer: ArrayBuffer[] } {
  // In a 3-variable problem the third packed component is the iterate's real
  // z coordinate (the client renders it verbatim, objective snapshot null),
  // not the 2D display lift.
  const is3Var = (request.objective as VecN).length >= 3;

  if (response.solver === "pdhg") {
    const result = response.result;
    const objective = request.objective as VecN;
    const eps = result.eps;
    const iterations = packIterations(result.iterations, is3Var ? (entry) => entry[2] ?? 0 : (entry, index) => objective[0]! * entry[0]! + objective[1]! * entry[1]! + PDHG_EPS_Z_LIFT * (eps?.[index] ?? 0));
    const rows = packRows(result.rows, (row: { epsilon: number }) => row.epsilon, true, is3Var);
    const wire: PackedSolverWorkerResponse = {
      id: response.id,
      success: true,
      packed: true,
      solver: "pdhg",
      iterations,
      stride: 3,
      rows,
      header: result.header,
      footer: result.footer,
      phases: result.phases,
      restartIndices: result.restartIndices,
    };
    return {
      wire,
      transfer: [iterations.buffer, rows.x.buffer, rows.y.buffer, ...(rows.z ? [rows.z.buffer] : []), rows.objective.buffer, rows.infeasibility.buffer, rows.extra.buffer, ...(rows.restart ? [rows.restart.buffer] : [])] as ArrayBuffer[],
    };
  }

  if (response.solver === "ipm") {
    const sol = response.result.iterates.solution;
    const objective = request.objective as VecN;
    const mu = sol.mu;
    const iterations = packIterations(sol.x, is3Var ? (entry) => entry[2] ?? 0 : (entry, index) => objective[0]! * entry[0]! + objective[1]! * entry[1]! + (mu?.[index] ?? 0));
    const rows = packRows(sol.rows, (row: { mu: number }) => row.mu, false, is3Var);
    const wire: PackedSolverWorkerResponse = {
      id: response.id,
      success: true,
      packed: true,
      solver: "ipm",
      iterations,
      stride: 3,
      rows,
      header: sol.header,
      footer: sol.footer,
    };
    return {
      wire,
      transfer: [iterations.buffer, rows.x.buffer, rows.y.buffer, ...(rows.z ? [rows.z.buffer] : []), rows.objective.buffer, rows.infeasibility.buffer, rows.extra.buffer] as ArrayBuffer[],
    };
  }

  if (response.solver === "ellipsoid") {
    const result = response.result;
    const objective = request.objective as VecN;
    const rho = result.rho;
    // 2D lifts the path by rho (the objective range still inside the
    // ellipsoid); a 3-variable solve has a real z instead
    const iterations = packIterations(
      result.iterations,
      is3Var
        ? (entry) => entry[2] ?? 0
        : (entry, index) =>
            objective[0]! * entry[0]! +
            objective[1]! * entry[1]! +
            (rho?.[index] ?? 0),
    );
    const rows = packRows(result.rows, (row: { rho: number }) => row.rho, false, is3Var);
    const wire: PackedSolverWorkerResponse = {
      id: response.id,
      success: true,
      packed: true,
      solver: "ellipsoid",
      iterations,
      stride: 3,
      rows,
      header: result.header,
      footer: result.footer,
      ellipsoids: result.ellipsoids,
      ellipsoidStride: result.ellipsoidStride,
      polygonPoints: result.polygonPoints,
      polygonOffsets: result.polygonOffsets,
      polygonStride: result.polygonStride,
    };
    return {
      wire,
      transfer: [
        iterations.buffer,
        rows.x.buffer,
        rows.y.buffer,
        rows.objective.buffer,
        rows.infeasibility.buffer,
        rows.extra.buffer,
        result.ellipsoids.buffer,
        // empty buffers are not worth a transfer, and skipping them keeps a
        // detached zero-length array from ever reaching the client
        ...(result.polygonPoints?.length ? [result.polygonPoints.buffer] : []),
        ...(result.polygonOffsets?.length ? [result.polygonOffsets.buffer] : []),
      ] as ArrayBuffer[],
    };
  }

  // simplex and central path results are small (few iterations / log strings)
  return { wire: response, transfer: [] };
}

export function unpackSolverResponse(wire: PackedSolverWorkerResponse): SolverWorkerResponse {
  if (!("packed" in wire) || !wire.packed) {
    return wire;
  }

  const iteratePath = unpackIteratePath(wire.iterations, wire.stride);
  const { x, y, z, objective, infeasibility, extra, restart } = wire.rows;

  // Row objects materialize lazily from the packed columns: only rows that
  // actually render (a screenful) are ever built, instead of one object per
  // iteration per solve.
  if (wire.solver === "pdhg") {
    return {
      id: wire.id,
      solver: "pdhg",
      success: true,
      result: {
        iterations: iteratePath,
        header: wire.header,
        rows: {
          length: x.length,
          at: (index: number) =>
            index >= 0 && index < x.length
              ? {
                  kind: "pdhg" as const,
                  iteration: index + 1,
                  restart: restart ? restart[index] === 1 : false,
                  x: x[index]!,
                  y: y[index]!,
                  ...(z ? { z: z[index]! } : {}),
                  objective: objective[index]!,
                  infeasibility: infeasibility[index]!,
                  epsilon: extra[index]!,
                }
              : undefined,
        },
        footer: wire.footer ?? "",
        phases: wire.phases,
        restartIndices: wire.restartIndices,
      },
    };
  }

  if (wire.solver === "ellipsoid") {
    const packedEllipsoids = wire.ellipsoids ?? new Float64Array(0);
    const ellipsoidStride = wire.ellipsoidStride ?? 5;
    const polygonPoints = wire.polygonPoints ?? new Float64Array(0);
    const polygonOffsets = wire.polygonOffsets ?? new Uint32Array(1);
    return {
      id: wire.id,
      solver: "ellipsoid",
      success: true,
      result: {
        iterations: iteratePath,
        ellipsoids: {
          data: packedEllipsoids,
          count: Math.floor(packedEllipsoids.length / ellipsoidStride),
          stride: ellipsoidStride,
        },
        localizingSets:
          polygonOffsets.length > 1
            ? {
                points: polygonPoints,
                offsets: polygonOffsets,
                count: polygonOffsets.length - 1,
                stride: wire.polygonStride ?? 2,
              }
            : null,
        header: wire.header,
        rows: {
          length: x.length,
          at: (index: number) =>
            index >= 0 && index < x.length
              ? {
                  kind: "ellipsoid" as const,
                  iteration: index + 1,
                  x: x[index]!,
                  y: y[index]!,
                  ...(z ? { z: z[index]! } : {}),
                  objective: objective[index]!,
                  infeasibility: infeasibility[index]!,
                  rho: extra[index]!,
                }
              : undefined,
        },
        footer: wire.footer ?? "",
      },
    };
  }

  return {
    id: wire.id,
    solver: "ipm",
    success: true,
    result: {
      iterates: {
        solution: {
          x: iteratePath,
          header: wire.header,
          rows: {
            length: x.length,
            at: (index: number) =>
              index >= 0 && index < x.length
                ? {
                    kind: "ipm" as const,
                    iteration: index + 1,
                    x: x[index]!,
                    y: y[index]!,
                    ...(z ? { z: z[index]! } : {}),
                    objective: objective[index]!,
                    infeasibility: infeasibility[index]!,
                    mu: extra[index]!,
                  }
                : undefined,
          },
          footer: wire.footer,
        },
      },
    },
  };
}
