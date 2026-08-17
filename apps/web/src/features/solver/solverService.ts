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

// Dispatch an unpacked worker result to the matching apply*Result. Replaces the
// per-solver applyResult that each SolverControl used to carry (each of which
// re-narrowed the response by solver — redundant, since the response already
// discriminates on `solver`).
export function applySolverResult(
  response: SolverWorkerSuccessResponse,
  updateResult: (payload: ResultRenderPayload) => void,
): void {
  switch (response.solver) {
    case "ipm":
      return applyIPMResult(response.result, updateResult);
    case "pdhg":
      return applyPDHGResult(response.result, updateResult);
    case "simplex":
      return applySimplexResult(response.result, updateResult);
    case "central":
      return applyCentralPathResult(response.result, updateResult);
    case "ellipsoid":
      return applyEllipsoidResult(response.result, updateResult);
  }
}

type VirtualResultRow =
  | string
  | {
      kind: "ipm";
      iteration: number;
      x: number;
      y: number;
      objective: number;
      infeasibility: number;
      mu: number;
    }
  | {
      kind: "pdhg";
      iteration: number;
      restart?: boolean;
      x: number;
      y: number;
      objective: number;
      infeasibility: number;
      epsilon: number;
    }
  | {
      kind: "ellipsoid";
      iteration: number;
      x: number;
      y: number;
      objective: number;
      infeasibility: number;
      rho: number;
    };

// Rows materialize lazily through this view so that a 100k-iteration result
// never pays for building row objects that are not scrolled into view.
type ResultRowsView<T = VirtualResultRow> = {
  length: number;
  at(index: number): T | undefined;
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

// Generic over the iterates representation: the worker/solver side emits one
// Float64Array per iterate (the default); after the worker packs and the client
// unpacks, the iterates are one flat IteratePath (no per-iterate views).
export interface IPMResult<I = Float64Array[]> {
  iterates: {
    solution: {
      x: I;
      header: string;
      rows: ResultRowsView<Extract<VirtualResultRow, { kind: "ipm" }>>;
      footer?: string;
      mu?: number[];
    };
  };
}

export interface SimplexResult {
  iterations: Float64Array[];
  phase1Iterations?: Float64Array[];
  logs: string[][];
  mode: "primal" | "dual";
  status?: "optimal" | "unbounded" | "infeasible";
}

export interface PDHGResult<I = Float64Array[]> {
  iterations: I;
  header: string;
  rows: ResultRowsView<Extract<VirtualResultRow, { kind: "pdhg" }>>;
  footer: string;
  eps?: number[];
  phases?: number[];
  restartIndices?: number[];
}

export interface CentralPathResult {
  iterations: Float64Array[];
  logs: string[];
  tsolve: number;
}

// `E` is the ellipse representation: a flat stride-5 Float64Array on the worker
// side, an EllipsoidPath once unpacked on the client (see resultPacking).
export interface EllipsoidResult<I = Float64Array[], E = Float64Array> {
  iterations: I;
  ellipsoids: E;
  // the cutting-plane query points also carry the localizing polyhedron: flat
  // on the worker side, a LocalizingSetPath once unpacked
  polygonPoints?: Float64Array;
  polygonOffsets?: Uint32Array;
  localizingSets?: LocalizingSetPath | null;
  header: string;
  rows: ResultRowsView<Extract<VirtualResultRow, { kind: "ellipsoid" }>>;
  footer: string;
  rho?: number[];
}

function applyIPMResult(
  result: IPMResult<IteratePath>,
  updateResult: (payload: ResultRenderPayload) => void,
) {
  const sol = result.iterates.solution;
  // worker-packed results arrive flat with the display z already baked in
  applyCanonicalIterateResult(
    {
      iterations: sol.x,
      header: sol.header,
      rows: sol.rows,
      footer: sol.footer,
    },
    updateResult,
  );
}

function applySimplexResult(
  result: SimplexResult,
  updateResult: (payload: ResultRenderPayload) => void,
) {
  const phase1Iterations = result.phase1Iterations ?? [];
  const iterations =
    phase1Iterations.length > 0
      ? [...phase1Iterations, ...result.iterations]
      : result.iterations;
  const phases =
    phase1Iterations.length > 0
      ? [
          ...Array.from({ length: phase1Iterations.length }, () => 0),
          ...Array.from({ length: result.iterations.length }, () => 1),
        ]
      : undefined;
  updateIteratePathsWithTrace(flattenIteratesToPath(iterations), phases);
  updateResult({
    type: "blocks",
    blocks: generateSimplexBlocks(
      result.logs[0],
      result.logs[1],
      result.status,
      phase1Iterations.length,
      result.iterations.length,
    ),
  });
}

function applyPDHGResult(
  result: PDHGResult<IteratePath>,
  updateResult: (payload: ResultRenderPayload) => void,
) {
  // worker-packed results arrive flat with the display z already baked in
  applyCanonicalIterateResult(
    {
      iterations: result.iterations,
      header: result.header,
      rows: result.rows,
      footer: result.footer,
      phases: result.phases,
      restartIndices: result.restartIndices,
    },
    updateResult,
  );
}

function applyEllipsoidResult(
  result: EllipsoidResult<IteratePath, EllipsoidPath>,
  updateResult: (payload: ResultRenderPayload) => void,
) {
  // worker-packed results arrive flat with the display z already baked in
  applyCanonicalIterateResult(
    {
      iterations: result.iterations,
      header: result.header,
      rows: result.rows,
      footer: result.footer,
      ellipsoids: result.ellipsoids,
      localizingSets: result.localizingSets ?? null,
    },
    updateResult,
  );
}

function applyCentralPathResult(
  result: CentralPathResult,
  updateResult: (payload: ResultRenderPayload) => void,
) {
  const path = flattenIteratesToPath(result.iterations);
  applyCanonicalIterateResult(
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

type CanonicalIterateResult = {
  iterations: IteratePath;
  header: string;
  rows: ResultRowsView;
  footer?: string;
  updateTrace?: boolean;
  phases?: number[];
  restartIndices?: number[];
  ellipsoids?: EllipsoidPath;
  localizingSets?: LocalizingSetPath | null;
};

export function formatVirtualResultRow(row: VirtualResultRow): string {
  if (typeof row === "string") return row;
  if (row.kind === "ipm" || row.kind === "ellipsoid") {
    const trailing = row.kind === "ipm" ? row.mu : row.rho;
    return `${fmtInt(row.iteration, 5)} ${fmtF(row.x, 8, 2)} ${fmtF(row.y, 8, 2)} ${fmtE(row.objective, 10, 1)} ${fmtE(row.infeasibility, 10, 1)} ${fmtE(trailing, 10, 1, false)}`;
  }
  const iterationLabel = row.restart ? `${row.iteration}r` : `${row.iteration}`;
  return `${fmtStr(iterationLabel, 5)} ${fmtF(row.x, 8, 2)} ${fmtF(row.y, 8, 2)} ${fmtE(row.objective, 10, 1)} ${fmtE(row.infeasibility, 10, 1)} ${fmtE(row.epsilon, 10, 1, false)}`;
}

function applyCanonicalIterateResult(
  {
    iterations,
    header,
    rows,
    footer,
    updateTrace = true,
    phases,
    restartIndices,
    ellipsoids,
    localizingSets,
  }: CanonicalIterateResult,
  updateResult: (payload: ResultRenderPayload) => void,
) {
  if (updateTrace) {
    updateIteratePathsWithTrace(
      iterations,
      phases,
      restartIndices,
      ellipsoids,
      localizingSets,
    );
  } else {
    updateIteratePaths(
      iterations,
      phases,
      restartIndices,
      ellipsoids,
      localizingSets,
    );
  }

  updateResult(buildIteratePayload({ header, rows, footer }));
}

function generateSimplexBlocks(
  phase1logs: string[] = [],
  phase2logs: string[] = [],
  status: SimplexResult["status"] = "optimal",
  phase1IterationCount = 0,
  phase2IterationCount = 0,
): ResultTextBlock[] {
  const normalizeLog = (value: string) => value.replace(/\n+$/g, "");
  const createBlock = (
    className: ResultTextBlock["className"],
    text: string,
    index?: number,
  ): ResultTextBlock => ({
    className,
    text: normalizeLog(text),
    index,
  });

  const phase1Header = phase1logs[0] ?? "No phase 1 logs.";
  const phase1Rows = phase1logs.length > 2 ? phase1logs.slice(1, -1) : [];
  const phase1Footer =
    phase1logs.length > 1 ? phase1logs[phase1logs.length - 1] : "";

  const phase2Header = phase2logs[0] ?? "No phase 2 logs.";
  const phase2Rows =
    phase2logs.length <= 1
      ? []
      : status === "unbounded" || status === "infeasible"
        ? phase2logs.slice(1)
        : phase2logs.slice(1, -1);
  const phase2Footer =
    status === "unbounded"
      ? "Unbounded LP"
      : status === "infeasible"
        ? "Infeasible LP"
        : phase2logs.length > 1
          ? phase2logs[phase2logs.length - 1]
          : "";

  const phase1Title = "Phase 1";
  const phase2Title = "Phase 2";
  const setupBlocks =
    phase1logs.length === 0
      ? []
      : [
          createBlock("iterate-header", `${phase1Title}\n${phase1Header}`),
          ...phase1Rows.map((log, i) =>
            i < phase1IterationCount
              ? createBlock("iterate-item", log, i)
              : createBlock("iterate-item-nohover", log),
          ),
          ...(phase1Footer
            ? [createBlock("iterate-footer", phase1Footer)]
            : []),
        ];

  return [
    ...setupBlocks,
    createBlock("iterate-header", `${phase2Title}\n${phase2Header}`),
    ...phase2Rows.map((log, i) =>
      i < phase2IterationCount
        ? createBlock("iterate-item", log, phase1IterationCount + i)
        : createBlock("iterate-item-nohover", log),
    ),
    ...(phase2Footer ? [createBlock("iterate-footer", phase2Footer)] : []),
  ];
}

function buildIteratePayload({
  header,
  rows,
  footer,
}: {
  header: string;
  rows: ResultRowsView;
  footer?: string;
}): VirtualResultPayload {
  return {
    type: "virtual",
    header,
    rows,
    footer,
  };
}
