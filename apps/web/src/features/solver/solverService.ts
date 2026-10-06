import { flattenIteratesToPath, updateIteratePathsWithTrace } from "@/features/core/store";
import type { CentralPathResult, IterateResult, ResultRenderPayload, ResultTextBlock, SimplexResult, SolverWorkerSuccessResponse, VirtualResultRow } from "@/features/solver/types";
import { fmtE, fmtF, fmtInt, fmtStr } from "@lpviz/solver-engine/fmt";

// Dispatch an unpacked worker result. simplex/central keep their own log
// shapes; pdhg/ipm/ellipsoid arrive as one IterateResult (see resultPacking).
export function applySolverResult(response: SolverWorkerSuccessResponse, updateResult: (payload: ResultRenderPayload) => void): void {
  switch (response.solver) {
    case "simplex":
      return applySimplexResult(response.result, updateResult);
    case "central":
      return applyCentralPathResult(response.result, updateResult);
    case "ipm":
    case "pdhg":
    case "ellipsoid":
      return applyIterateResult(response.result, updateResult);
  }
}

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
  applyIterateResult(
    {
      iterations: flattenIteratesToPath(result.iterations),
      header: result.logs[0] ?? "",
      // central-path logs carry no footer line (the footer below is synthesized)
      rows: result.logs.slice(1),
      footer: `Traced central path in ${Math.round(result.tsolve * 1000)}ms`,
    },
    updateResult,
  );
}

export function formatVirtualResultRow(row: VirtualResultRow): string {
  if (typeof row === "string") return row;
  const iteration = row.kind === "pdhg" ? fmtStr(row.restart ? `${row.iteration}r` : `${row.iteration}`, 5) : fmtInt(row.iteration, 5);
  return `${iteration} ${fmtF(row.x, 8, 2)} ${fmtF(row.y, 8, 2)} ${fmtE(row.objective, 10, 1)} ${fmtE(row.infeasibility, 10, 1)} ${fmtE(row.extra, 10, 1, false)}`;
}

function applyIterateResult({ iterations, header, rows, footer, phases, restartIndices, ellipsoids, localizingSets }: IterateResult, updateResult: (payload: ResultRenderPayload) => void) {
  updateIteratePathsWithTrace(iterations, phases, restartIndices, ellipsoids, localizingSets);

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
