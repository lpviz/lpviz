import { getState, setState } from "@/features/core/store";
import { formatVirtualResultRow } from "@/features/solver/resultPacking";
import type { ResultTextBlock, ResultView } from "@/features/solver/types";
import type { LazyRows, ResultLogSection, VirtualResultRow } from "@/features/solver/types";

/** What a solve renders: a single run as a header, lazily formatted rows and a footer, or a phased run (or a message) as blocks. */
export type VirtualResultPayload = { kind: "virtual"; header: string; rows: LazyRows; footer: string };
export type ResultRenderPayload = VirtualResultPayload | { kind: "blocks"; blocks: ResultTextBlock[] };

// While the objective rotates the log is re-rendered on every step, so it shows
// a window of this many rows instead of the whole run: the first rows, a gap
// marker, then the last rows — so the final iterate, the one the viewport marks
// as the answer, stays in view instead of the run appearing to end at row 20.
const ROTATE_ROW_LIMIT = 20;
const ROTATE_TAIL_ROWS = 8;

type RenderOptions = { limitVirtualRows?: boolean };

// Log text ends without a newline: the panel renders it with the line breaks kept, so a trailing
// one would be a blank line.
const normalizeLog = (value: string) => value.replace(/\n+$/g, "");

// A one-section log is a single run and scrolls as a virtual list; a log with
// several sections is a phased run (simplex), small enough to render as blocks.
export function renderPayload(log: ResultLogSection[]): ResultRenderPayload {
  const [section] = log;
  if (section && log.length === 1) {
    return { kind: "virtual", header: normalizeLog(section.header), rows: section.rows, footer: normalizeLog(section.footer ?? "") };
  }
  return { kind: "blocks", blocks: phaseBlocks(log) };
}

const block = (kind: ResultTextBlock["kind"], text: string, index?: number): ResultTextBlock => ({ kind, text, index });

function phaseBlocks(log: ResultLogSection[]): ResultTextBlock[] {
  const blocks: ResultTextBlock[] = [];
  // a row's index is its iterate's position in the whole path
  let offset = 0;
  log.forEach(({ header, rows, notes = [], footer }, phase) => {
    blocks.push(block("header", normalizeLog(`Phase ${phase + 1}\n${header}`)));
    for (let i = 0; i < rows.length; i++) blocks.push(block("row", normalizeLog(formatVirtualResultRow(rows.at(i)!)), offset + i));
    for (const note of notes) blocks.push(block("note", normalizeLog(note)));
    if (footer) blocks.push(block("footer", normalizeLog(footer)));
    offset += rows.length;
  });
  return blocks;
}

const getMaxLineChars = (constraints: string[]) => constraints.reduce((m, line) => Math.max(m, ...line.split("\n").map((l) => l.length)), 0);
const rowBlock = (row: VirtualResultRow, index: number): ResultTextBlock => block("row", formatVirtualResultRow(row), index);
const USAGE: ResultView = { kind: "usage" };

/** A two-line result: a header and the one line under it (why a solver did not run, or its error). */
export const messageBlocks = (header: string, message: string): ResultRenderPayload => ({
  kind: "blocks",
  blocks: [block("header", header), block("note", message)],
});

export type ResultPresenter = {
  // push a solver result into the store's result view (deferred while the
  // viewport is mid-navigation; see render)
  render: (payload: ResultRenderPayload, options?: RenderOptions) => void;
  // render a solver failure as a two-line block result
  renderError: (message: string) => void;
  // apply a render deferred during viewport navigation, once it has ended
  flushDeferred: () => void;
  // reset the result panel to its usage/placeholder state
  clearResult: () => void;
  // re-render the last virtual result without the rotation row cap
  restoreFullVirtualResult: () => void;
};

// How a solver result becomes the store's result view: virtual-vs-blocks shaping, the
// widest-line measurement, the rotation row cap, and the defer-while-navigating buffer.
export function createResultPresenter(): ResultPresenter {
  let lastVirtualResult: VirtualResultPayload | null = null;
  let pendingRender: {
    payload: ResultRenderPayload;
    options: RenderOptions;
  } | null = null;

  const show = (result: ResultView) => setState({ result, highlightIteratePathIndex: null });

  const applyRender = (payload: ResultRenderPayload, options: RenderOptions = {}) => {
    const limitVirtualRows = options.limitVirtualRows ?? getState().rotateObjectiveMode;
    if (payload.kind === "virtual") {
      const rows = payload.rows;
      const windowed = limitVirtualRows && rows.length > ROTATE_ROW_LIMIT;
      const rowCount = windowed ? ROTATE_ROW_LIMIT : rows.length;
      const headCount = ROTATE_ROW_LIMIT - ROTATE_TAIL_ROWS - 1;
      const hiddenCount = rows.length - (ROTATE_ROW_LIMIT - 1);
      // a windowed row keeps its own index, so hovering a tail row still
      // highlights that iterate on the canvas
      const blockAt = (index: number): ResultTextBlock | undefined => {
        if (index < 0 || index >= rowCount) return undefined;
        if (windowed && index === headCount) {
          return block("note", `    ⋯ ${hiddenCount} iterations not shown while rotating ⋯ `);
        }
        const sourceIndex = windowed && index > headCount ? rows.length - (rowCount - index) : index;
        const row = rows.at(sourceIndex);
        return row === undefined ? undefined : rowBlock(row, sourceIndex);
      };
      // Rows are fixed-width; sampling three avoids formatting all of them
      // (100k at max settings) just to measure the widest line.
      const sampleBlocks = rowCount > 0 ? [blockAt(0), blockAt(rowCount >> 1), blockAt(rowCount - 1)] : [];
      show({
        kind: "virtual",
        header: payload.header,
        footer: payload.footer,
        rows: { length: rowCount, at: blockAt },
        maxLineChars: getMaxLineChars([payload.header, payload.footer, ...sampleBlocks.flatMap((block) => (block ? [block.text] : []))]),
      });
    } else {
      show({ kind: "blocks", blocks: payload.blocks, maxLineChars: getMaxLineChars(payload.blocks.map((b) => b.text)) });
    }
  };
  // lastVirtualResult is the latest virtual payload, which restoreFullVirtualResult re-renders
  // without the rotation cap; a deferred render is flushed with the payload it recorded
  const render = (payload: ResultRenderPayload, options: RenderOptions = {}) => {
    lastVirtualResult = payload.kind === "virtual" ? payload : null;
    if (getState().isNavigatingViewport) {
      pendingRender = { payload, options };
      return;
    }
    pendingRender = null;
    applyRender(payload, options);
  };

  return {
    render,
    renderError: (message: string) => render(messageBlocks("Solver error", message)),
    flushDeferred: () => {
      if (!pendingRender || getState().isNavigatingViewport) return;
      const p = pendingRender;
      pendingRender = null;
      applyRender(p.payload, p.options);
    },
    clearResult: () => {
      lastVirtualResult = null;
      pendingRender = null;
      show(USAGE);
    },
    restoreFullVirtualResult: () => {
      if (lastVirtualResult) render(lastVirtualResult, { limitVirtualRows: false });
    },
  };
}
