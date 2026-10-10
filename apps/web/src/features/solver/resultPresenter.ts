import { getState, setState } from "@/features/core/store";
import { formatVirtualResultRow } from "@/features/solver/resultPacking";
import type { ResultLogSection, ResultRenderPayload, ResultTextBlock, VirtualResultPayload, VirtualResultRow } from "@/features/solver/types";

// While the objective rotates the log is re-rendered on every step, so it shows
// a window of this many rows instead of the whole run: the first rows, a gap
// marker, then the last rows — so the final iterate, the one the viewport marks
// as the answer, stays in view instead of the run appearing to end at row 20.
const ROTATE_ROW_LIMIT = 20;
const ROTATE_TAIL_ROWS = 8;

type RenderOptions = { limitVirtualRows?: boolean };

// A one-section log is a single run and scrolls as a virtual list; a log with
// several sections is a phased run (simplex), small enough to render as blocks.
export function renderPayload(log: ResultLogSection[]): ResultRenderPayload {
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

const getMaxLineChars = (constraints: string[]) => constraints.reduce((m, line) => Math.max(m, ...line.split("\n").map((l) => l.length)), 0);
const createVirtualBlock = (row: VirtualResultRow, index: number): ResultTextBlock => ({
  className: "iterate-item",
  text: formatVirtualResultRow(row),
  index,
});
const createResultBlock = (className: ResultTextBlock["className"], text: string): ResultTextBlock => ({ className, text });
// fresh per call: resultVirtualRows must be a new array so the store sees a change
const noVirtualRows = () => ({ resultVirtualHeader: null, resultVirtualFooter: null, resultVirtualShowEmpty: false, resultVirtualRows: [] });

export type ResultPresenter = {
  // push a solver result into the store's result-display fields (deferred while
  // the viewport is mid-navigation; see render)
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

// How a solver result becomes result-panel store state: virtual-vs-blocks shaping, the
// widest-line measurement, the rotation row cap, and the defer-while-navigating buffer.
export function createResultPresenter(): ResultPresenter {
  let lastVirtualResult: VirtualResultPayload | null = null;
  let pendingRender: {
    payload: ResultRenderPayload;
    options: RenderOptions;
  } | null = null;

  const applyRender = (payload: ResultRenderPayload, options: RenderOptions = {}) => {
    const limitVirtualRows = options.limitVirtualRows ?? getState().rotateObjectiveMode;
    if (payload.type === "virtual") {
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
          return createResultBlock("iterate-item-nohover", `    ⋯ ${hiddenCount} iterations not shown while rotating ⋯ `);
        }
        const sourceIndex = windowed && index > headCount ? rows.length - (rowCount - index) : index;
        const row = rows.at(sourceIndex);
        return row === undefined ? undefined : createVirtualBlock(row, sourceIndex);
      };
      // Rows are fixed-width; sampling three avoids formatting all of them
      // (100k at max settings) just to measure the widest line.
      const sampleBlocks = rowCount > 0 ? [blockAt(0), blockAt(rowCount >> 1), blockAt(rowCount - 1)] : [];
      setState({
        resultDisplayMode: "virtual",
        resultBlocks: null,
        resultVirtualHeader: payload.header || "",
        resultVirtualFooter: payload.footer ?? null,
        resultVirtualShowEmpty: rowCount === 0,
        resultVirtualRows: { length: rowCount, at: blockAt },
        resultMaxLineChars: getMaxLineChars([payload.header || "", ...(payload.footer ? [payload.footer] : []), ...sampleBlocks.flatMap((block) => (block ? [block.text] : []))]),
        highlightIteratePathIndex: null,
      });
    } else {
      setState({
        resultDisplayMode: "blocks",
        resultBlocks: payload.blocks,
        ...noVirtualRows(),
        resultMaxLineChars: getMaxLineChars(payload.blocks.map((b) => b.text)),
        highlightIteratePathIndex: null,
      });
    }
  };
  // the only writer besides clearResult: a deferred render is flushed with the
  // payload recorded here, so applyRender need not set it again
  const render = (payload: ResultRenderPayload, options: RenderOptions = {}) => {
    lastVirtualResult = payload.type === "virtual" ? payload : null;
    if (getState().isNavigatingViewport) {
      pendingRender = { payload, options };
      return;
    }
    pendingRender = null;
    applyRender(payload, options);
  };

  return {
    render,
    renderError: (message: string) =>
      render({
        type: "blocks",
        blocks: [createResultBlock("iterate-header", "Solver error"), createResultBlock("iterate-item-nohover", message)],
      }),
    flushDeferred: () => {
      if (!pendingRender || getState().isNavigatingViewport) return;
      const p = pendingRender;
      pendingRender = null;
      applyRender(p.payload, p.options);
    },
    clearResult: () => {
      lastVirtualResult = null;
      pendingRender = null;
      setState({ resultDisplayMode: "usage", resultBlocks: null, ...noVirtualRows(), resultMaxLineChars: 0, highlightIteratePathIndex: null });
    },
    restoreFullVirtualResult: () => {
      if (lastVirtualResult) render(lastVirtualResult, { limitVirtualRows: false });
    },
  };
}
