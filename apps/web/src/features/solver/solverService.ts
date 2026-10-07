import { updateIteratePathsWithTrace } from "@/features/core/store";
import type { ResultLogSection, ResultRenderPayload, ResultTextBlock, SolverWorkerSuccessResponse, VirtualResultRow } from "@/features/solver/types";
import { fmtCoordinates, fmtE, fmtStr, logColumnWidths } from "@lpviz/solver-engine/fmt";

// Push an unpacked worker result into the store's iterate fields and hand its
// log to the result panel.
export function applySolverResult({ result }: SolverWorkerSuccessResponse, updateResult: (payload: ResultRenderPayload) => void): void {
  const { iterations, log, phases, restartIndices, ellipsoids, localizingSets } = result;
  updateIteratePathsWithTrace(iterations, phases, restartIndices, ellipsoids, localizingSets);
  updateResult(renderPayload(log));
}

export function formatVirtualResultRow(row: VirtualResultRow): string {
  if (typeof row === "string") return row;
  const iteration = fmtStr(row.restart ? `${row.iteration}r` : `${row.iteration}`, 5);
  const { coordinate, measure } = logColumnWidths(row.point.length);
  return `${iteration} ${fmtCoordinates(row.point, coordinate)} ${fmtE(row.objective, measure, 1)} ${fmtE(row.infeasibility, measure, 1)} ${fmtE(row.convergence, measure, 1, false)}`;
}

// A one-section log is a single run and scrolls as a virtual list; a log with
// several sections is a phased run (simplex), small enough to render as blocks.
function renderPayload(log: ResultLogSection[]): ResultRenderPayload {
  const [section] = log;
  if (section && log.length === 1) {
    return { type: "virtual", header: section.header, rows: section.rows, footer: section.footer ?? "" };
  }
  return { type: "blocks", blocks: phaseBlocks(log) };
}

function phaseBlocks(log: ResultLogSection[]): ResultTextBlock[] {
  const normalizeLog = (value: string) => value.replace(/\n+$/g, "");
  const createBlock = (className: ResultTextBlock["className"], text: string, index?: number): ResultTextBlock => ({
    className,
    text: normalizeLog(text),
    index,
  });

  const blocks: ResultTextBlock[] = [];
  // a row's index is its iterate's position in the whole path
  let offset = 0;
  log.forEach(({ header, rows, notes = [], footer }, phase) => {
    blocks.push(createBlock("iterate-header", `Phase ${phase + 1}\n${header}`));
    for (let i = 0; i < rows.length; i++) blocks.push(createBlock("iterate-item", formatVirtualResultRow(rows.at(i)!), offset + i));
    for (const note of notes) blocks.push(createBlock("iterate-item-nohover", note));
    if (footer) blocks.push(createBlock("iterate-footer", footer));
    offset += rows.length;
  });
  return blocks;
}
