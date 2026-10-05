import {
  addTraceToBuffer,
  flattenIteratesToPath,
  getState,
  updateIteratePaths,
  updateIteratePathsWithTrace,
  type EllipsoidPath,
  type IteratePath,
  type LocalizingSetPath,
} from "@/features/core/store";
import type { ResultTextBlock } from "@/features/solver/types";
import type { SolverWorkerSuccessResponse } from "@/features/solver/solverWorker";
import { fmtE, fmtF, fmtInt, fmtStr } from "@lpviz/solver-engine/fmt";

// Dispatch an unpacked worker result. simplex/central keep their own log
// shapes; pdhg/ipm/ellipsoid arrive as one IterateResult (see resultPacking).
export function applySolverResult(response: SolverWorkerSuccessResponse, updateResult: (payload: ResultRenderPayload) => void): void {
  switch (response.solver) {
    case "simplex":
      return applySimplexResult(response.result, updateResult);
    case "central":
      return applyCentralPathResult(response.result, updateResult);
    default:
      return applyIterateResult(response.result, updateResult);
  }
}

export type PackedSolver = "pdhg" | "ipm" | "ellipsoid";

// One row shape for the three packed solvers; `extra` is each one's convergence
// measure (pdhg eps, ipm mu, ellipsoid rho), the trailing log column.
type VirtualResultRow = string | { kind: PackedSolver; iteration: number; restart?: boolean; x: number; y: number; objective: number; infeasibility: number; extra: number };

// Rows materialize lazily through this view so that a 100k-iteration result
// never pays for building row objects that are not scrolled into view.
type ResultRowsView = {
  length: number;
  at(index: number): VirtualResultRow | undefined;
};

export interface VirtualResultPayload {
  type: "virtual";
  header: string;
  rows: ResultRowsView;
  footer?: string;
}

interface BlocksResultPayload {
  type: "blocks";
  blocks: ResultTextBlock[];
}

export type ResultRenderPayload = VirtualResultPayload | BlocksResultPayload;

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

// What the client receives for pdhg/ipm/ellipsoid once unpacked: the iterates
// flat with the display z already baked in, plus whatever the solver drew.
export type IterateResult = {
  iterations: IteratePath;
  header: string;
  rows: ResultRowsView;
  footer?: string;
  phases?: number[];
  restartIndices?: number[];
  ellipsoids?: EllipsoidPath;
  localizingSets?: LocalizingSetPath | null;
};

function applySimplexResult(result: SimplexResult, updateResult: (payload: ResultRenderPayload) => void) {
  const phase1Iterations = result.phase1Iterations ?? [];
  const iterations = phase1Iterations.length > 0 ? [...phase1Iterations, ...result.iterations] : result.iterations;
  const phases = phase1Iterations.length > 0 ? [...Array.from({ length: phase1Iterations.length }, () => 0), ...Array.from({ length: result.iterations.length }, () => 1)] : undefined;
  updateIteratePathsWithTrace(flattenIteratesToPath(iterations), phases);
  updateResult({
    type: "blocks",
    blocks: generateSimplexBlocks(result.logs[0], result.logs[1], result.status, phase1Iterations.length, result.iterations.length),
  });
}

function applyCentralPathResult(result: CentralPathResult, updateResult: (payload: ResultRenderPayload) => void) {
  const path = flattenIteratesToPath(result.iterations);
  applyIterateResult(
    {
      iterations: path,
      header: result.logs[0] ?? "",
      // central-path logs carry no footer line (the footer below is synthesized)
      rows: result.logs.slice(1),
      footer: `Traced central path in ${Math.round(result.tsolve * 1000)}ms`,
      updateTrace: false,
    },
    updateResult,
  );

  const { traceEnabled } = getState();
  if (traceEnabled && path.count > 0) {
    addTraceToBuffer(path);
  }
}

export function formatVirtualResultRow(row: VirtualResultRow): string {
  if (typeof row === "string") return row;
  const iteration = row.kind === "pdhg" ? fmtStr(row.restart ? `${row.iteration}r` : `${row.iteration}`, 5) : fmtInt(row.iteration, 5);
  return `${iteration} ${fmtF(row.x, 8, 2)} ${fmtF(row.y, 8, 2)} ${fmtE(row.objective, 10, 1)} ${fmtE(row.infeasibility, 10, 1)} ${fmtE(row.extra, 10, 1, false)}`;
}

function applyIterateResult(
  { iterations, header, rows, footer, updateTrace = true, phases, restartIndices, ellipsoids, localizingSets }: IterateResult & { updateTrace?: boolean },
  updateResult: (payload: ResultRenderPayload) => void,
) {
  if (updateTrace) {
    updateIteratePathsWithTrace(iterations, phases, restartIndices, ellipsoids, localizingSets);
  } else {
    updateIteratePaths(iterations, phases, restartIndices, ellipsoids, localizingSets);
  }

  updateResult({ type: "virtual", header, rows, footer });
}

function generateSimplexBlocks(
  phase1logs: string[] = [],
  phase2logs: string[] = [],
  status: SimplexResult["status"] = "optimal",
  phase1IterationCount = 0,
  phase2IterationCount = 0,
): ResultTextBlock[] {
  const normalizeLog = (value: string) => value.replace(/\n+$/g, "");
  const createBlock = (className: ResultTextBlock["className"], text: string, index?: number): ResultTextBlock => ({
    className,
    text: normalizeLog(text),
    index,
  });

  const phase1Header = phase1logs[0] ?? "No phase 1 logs.";
  const phase1Rows = phase1logs.length > 2 ? phase1logs.slice(1, -1) : [];
  const phase1Footer = phase1logs.length > 1 ? phase1logs[phase1logs.length - 1] : "";

  const phase2Header = phase2logs[0] ?? "No phase 2 logs.";
  const phase2Rows = phase2logs.length <= 1 ? [] : status === "unbounded" || status === "infeasible" ? phase2logs.slice(1) : phase2logs.slice(1, -1);
  const phase2Footer = status === "unbounded" ? "Unbounded LP" : status === "infeasible" ? "Infeasible LP" : phase2logs.length > 1 ? phase2logs[phase2logs.length - 1] : "";

  const phase1Title = "Phase 1";
  const phase2Title = "Phase 2";
  const setupBlocks =
    phase1logs.length === 0
      ? []
      : [
          createBlock("iterate-header", `${phase1Title}\n${phase1Header}`),
          ...phase1Rows.map((log, i) => (i < phase1IterationCount ? createBlock("iterate-item", log, i) : createBlock("iterate-item-nohover", log))),
          ...(phase1Footer ? [createBlock("iterate-footer", phase1Footer)] : []),
        ];

  return [
    ...setupBlocks,
    createBlock("iterate-header", `${phase2Title}\n${phase2Header}`),
    ...phase2Rows.map((log, i) => (i < phase2IterationCount ? createBlock("iterate-item", log, phase1IterationCount + i) : createBlock("iterate-item-nohover", log))),
    ...(phase2Footer ? [createBlock("iterate-footer", phase2Footer)] : []),
  ];
}
