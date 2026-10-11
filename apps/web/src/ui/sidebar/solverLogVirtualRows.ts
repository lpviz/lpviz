import { singleFrame } from "@/features/core/timers";
import type { LazyList } from "@/features/solver/solverState";
import type { ResultTextBlock } from "@/features/solver/solverState";
import { el } from "@/ui/dom";

// how the panel styles each kind of line
const BLOCK_CLASS: Record<ResultTextBlock["kind"], string> = { header: "iterate-header", row: "iterate-item", note: "iterate-item-nohover", footer: "iterate-footer" };
export const rowEl = (block: ResultTextBlock) => el("div", { className: BLOCK_CLASS[block.kind], text: block.text, attrs: block.index !== undefined ? { "data-index": String(block.index) } : {} });
// a row's node made to show another block, as rowEl would have made it
function setRow(node: HTMLElement, block: ResultTextBlock): void {
  node.className = BLOCK_CLASS[block.kind];
  node.textContent = block.text;
  if (block.index !== undefined) node.dataset.index = String(block.index);
  else delete node.dataset.index;
}

/** The rows mounted in the log: refilled when the panel's height changes, or shown another run's rows in place (re-measured when the panel's width or font changed). */
export type VirtualRows = { refill: () => void; update: (blocks: LazyList<ResultTextBlock>, remeasure: boolean) => void };

// The font is sized so the widest line fits the panel: the stylesheet's size, the monospace
// glyph width as a fraction of it, and the range the fit may land in.
const BASE_FONT_PX = 18;
const GLYPH_WIDTH_EM = 0.55;
const FIT_SHRINK = 0.875;
const FIT_SLACK_PX = 10;
const MAX_FIT_SCALE = 4;
const MIN_FONT_PX = 10;
const MAX_FONT_PX = 24;
// before a row or the panel has a measured height
const FALLBACK_ROW_HEIGHT_PX = 18;
const FALLBACK_VIEW_HEIGHT_PX = 600;

// Sizes the result's font to fit the widest line in its width. Nothing here reads layout: the
// horizontal padding is static CSS read once, and the width is what the size observer last
// reported, so a render (a rotation step's, dozens a second) forces no layout pass of its own.
export function createResultFit(result: HTMLElement) {
  let cachedPadding: number | null = null;
  let width = result.clientWidth;
  let lastFitKey = "";
  return {
    setWidth: (next: number) => {
      width = next;
    },
    /** Fit the font to `maxLineChars` (0 clears the fit); true when the font size changed. */
    fit: (maxLineChars: number): boolean => {
      if (maxLineChars > 0) {
        if (cachedPadding === null) {
          const containerStyle = window.getComputedStyle(result);
          cachedPadding = (parseFloat(containerStyle.paddingLeft) || 0) + (parseFloat(containerStyle.paddingRight) || 0);
        }
        const effectiveWidth = width - cachedPadding;
        const fitKey = `${maxLineChars}|${effectiveWidth}`;
        if (fitKey === lastFitKey) return false;
        lastFitKey = fitKey;
        if (effectiveWidth > 0) {
          const targetWidth = Math.max(1, effectiveWidth - FIT_SLACK_PX);
          const maxLineWidth = maxLineChars * BASE_FONT_PX * GLYPH_WIDTH_EM;
          const scale = Math.min(MAX_FIT_SCALE, Math.max(0, targetWidth / maxLineWidth));
          const fontSize = Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, BASE_FONT_PX * scale * FIT_SHRINK));
          result.style.fontSize = `${fontSize}px`;
          result.style.setProperty("--virtual-font-size", `${fontSize}px`);
        }
      } else {
        lastFitKey = "";
        result.style.fontSize = "";
        result.style.removeProperty("--virtual-font-size");
      }
      return true;
    },
  };
}

// Windowed rendering: only the rows near the viewport get DOM nodes, with
// spacer divs holding the scroll height. Materializing every row (100k at
// max solver settings) costs seconds of main-thread time per render.
const VIRTUAL_OVERSCAN_ROWS = 20;
// Returns the mounted rows (null without any), so a panel that changes height can re-window
// without a full re-render, and the next run's rows (a rotation step's, dozens of times a second)
// can take over the nodes already there instead of rebuilding them.
export function mountVirtualRows(sc: HTMLElement, initial: LazyList<ResultTextBlock>, result: HTMLElement): VirtualRows | null {
  const topSpacer = el("div");
  const rowsEl = el("div", { className: "iterate-rows" });
  const bottomSpacer = el("div");
  sc.append(el("div", { className: "iterate-virtual-wrapper" }, [topSpacer, rowsEl, bottomSpacer]));
  if (initial.length === 0) return null;

  let blocks = initial;
  let rowHeight = 0;
  // the scroll position and the view's height as last read, each read again only when it moved
  let scrollTop = 0;
  let viewHeight = 0;
  const measureView = () => {
    viewHeight = sc.clientHeight || result.clientHeight || FALLBACK_VIEW_HEIGHT_PX;
  };
  let windowStart = -1;
  let windowEnd = -1;
  const fillWindow = () => {
    if (rowHeight <= 0) {
      const probe = rowEl(blocks.at(0)!);
      rowsEl.append(probe);
      rowHeight = probe.offsetHeight || FALLBACK_ROW_HEIGHT_PX;
      probe.remove();
    }
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - VIRTUAL_OVERSCAN_ROWS);
    const end = Math.min(blocks.length, Math.ceil((scrollTop + viewHeight) / rowHeight) + VIRTUAL_OVERSCAN_ROWS);
    if (start === windowStart && end === windowEnd) return;
    windowStart = start;
    windowEnd = end;
    topSpacer.style.height = `${start * rowHeight}px`;
    bottomSpacer.style.height = `${(blocks.length - end) * rowHeight}px`;
    // the nodes already there show the window's first rows; the rest are made or dropped
    const nodes = rowsEl.children;
    for (let i = start, k = 0; i < end; i++, k++) {
      const block = blocks.at(i)!;
      const node = nodes[k];
      if (node instanceof HTMLElement) setRow(node, block);
      else rowsEl.append(rowEl(block));
    }
    while (nodes.length > end - start) nodes[nodes.length - 1]!.remove();
  };

  const refill = singleFrame();
  sc.addEventListener(
    "scroll",
    () => {
      scrollTop = sc.scrollTop;
      refill.request(fillWindow);
    },
    { passive: true },
  );
  measureView();
  fillWindow();
  return {
    refill: () => {
      measureView();
      fillWindow();
    },
    update: (next, remeasure) => {
      blocks = next;
      // a fresh run reads from the top (the write alone would force a layout pass)
      if (scrollTop !== 0) sc.scrollTop = 0;
      scrollTop = 0;
      if (remeasure) {
        rowHeight = 0;
        measureView();
      }
      windowStart = -1;
      fillWindow();
    },
  };
}

// The panel is resized independently of its contents (sidebar handle, log
// expansion). A width change needs the full re-render, since fit() sizes the
// font to the width; a height change only needs the virtual window refilled,
// which matters because expanding the log emits a stream of height changes.
export function observeResultSize(result: HTMLElement, { onWidthChange, onHeightChange }: { onWidthChange: (width: number) => void; onHeightChange: () => void }) {
  let fittedWidth = result.clientWidth;
  let fittedHeight = result.clientHeight;
  const sizeObserver = new ResizeObserver(() => {
    const width = result.clientWidth;
    const height = result.clientHeight;
    if (width !== fittedWidth) {
      fittedWidth = width;
      fittedHeight = height;
      onWidthChange(width);
      return;
    }
    if (height === fittedHeight) return;
    fittedHeight = height;
    onHeightChange();
  });
  sizeObserver.observe(result);
  return sizeObserver;
}
