import { getState, setState } from "@/features/core/store";
import { formatVirtualResultRow, type ResultRenderPayload, type VirtualResultPayload } from "@/features/solver/solverService";
import type { ResultTextBlock } from "@/features/solver/types";
import type { ViewportApi } from "@/features/viewport/runtime";

// While the objective rotates the log is re-rendered on every step, so it shows
// a window of this many rows instead of the whole run: the first rows, a gap
// marker, then the last rows — so the final iterate, the one the viewport marks
// as the answer, stays in view instead of the run appearing to end at row 20.
const ROTATE_ROW_LIMIT = 20;
const ROTATE_TAIL_ROWS = 8;

type RenderOptions = { limitVirtualRows?: boolean };

const getMaxLineChars = (lines: string[]) => lines.reduce((m, line) => Math.max(m, ...line.split("\n").map((l) => l.length)), 0);
const createVirtualBlock = (row: NonNullable<ReturnType<VirtualResultPayload["rows"]["at"]>>, index: number): ResultTextBlock => ({
  className: "iterate-item",
  text: formatVirtualResultRow(row),
  index,
});
const createResultBlock = (className: ResultTextBlock["className"], text: string): ResultTextBlock => ({ className, text });

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

// Owns how a solver result becomes result-panel store state: virtual-vs-blocks
// shaping, the widest-line measurement, the rotation row cap, and the
// defer-while-navigating buffer. Extracted from solverActions so the
// render/applyRender/pendingRender/lastVirtualResult tangle lives behind a small
// interface instead of four closures sharing two mutable locals.
export function createResultPresenter(deps: { getCanvasManager: () => ViewportApi | null }): ResultPresenter {
  let lastVirtualResult: VirtualResultPayload | null = null;
  let pendingRender: {
    payload: ResultRenderPayload;
    options: RenderOptions;
  } | null = null;

  const applyRender = (payload: ResultRenderPayload, options: RenderOptions = {}) => {
    const cm = deps.getCanvasManager();
    const limitVirtualRows = options.limitVirtualRows ?? getState().rotateObjectiveMode;
    if (payload.type === "virtual") {
      lastVirtualResult = payload;
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
      lastVirtualResult = null;
      setState({
        resultDisplayMode: "blocks",
        resultBlocks: payload.blocks,
        resultVirtualHeader: null,
        resultVirtualFooter: null,
        resultVirtualShowEmpty: false,
        resultVirtualRows: [],
        resultMaxLineChars: getMaxLineChars(payload.blocks.map((b) => b.text)),
        highlightIteratePathIndex: null,
      });
    }
    cm?.draw();
  };
  const render = (payload: ResultRenderPayload, options: RenderOptions = {}) => {
    if (payload.type === "virtual") lastVirtualResult = payload;
    else lastVirtualResult = null;
    if (getState().isNavigatingViewport) {
      pendingRender = { payload, options };
      deps.getCanvasManager()?.draw();
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
      setState({
        resultDisplayMode: "usage",
        resultBlocks: null,
        resultVirtualHeader: null,
        resultVirtualFooter: null,
        resultVirtualShowEmpty: false,
        resultVirtualRows: [],
        resultMaxLineChars: 0,
        highlightIteratePathIndex: null,
      });
      deps.getCanvasManager()?.draw();
    },
    restoreFullVirtualResult: () => {
      if (lastVirtualResult) render(lastVirtualResult, { limitVirtualRows: false });
    },
  };
}
