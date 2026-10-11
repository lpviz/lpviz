import { onAbort } from "@/features/core/lifetime";
import { singleFrame } from "@/features/core/timers";
import type { LazyList } from "@/features/solver/types";
import type { ResultTextBlock } from "@/features/solver/types";
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

/** A single run as the log shows it: a header, lazily formatted rows and a footer. */
export type VirtualView = { header: string; footer: string; rows: LazyList<ResultTextBlock> };
/** The run mounted in the log: refilled when the panel's height changes, or shown another run in place (re-measured when the panel's width or font changed). */
export type VirtualRows = { refill: () => void; show: (view: VirtualView, remeasure: boolean) => void };

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

// Sizes the result's font to fit the widest line in its width, and follows the panel's size. The
// panel is resized independently of its contents (sidebar handle, log expansion): a width change
// needs the full re-render, since the font is sized to the width, while a height change only needs
// the virtual window refilled, which matters because expanding the log emits a stream of height
// changes. Nothing on the render path reads layout: the horizontal padding is static CSS read
// once, and the width is what the observer last saw, so a render (a rotation step's, dozens a
// second) forces no layout pass of its own.
export function createResultFit(result: HTMLElement, { rerender, refill }: { rerender: () => void; refill: () => void }, signal: AbortSignal) {
  let cachedPadding: number | null = null;
  let width = result.clientWidth;
  let height = result.clientHeight;
  let lastFitKey = "";
  const observer = new ResizeObserver(() => {
    if (result.clientWidth !== width) {
      width = result.clientWidth;
      height = result.clientHeight;
      rerender();
      return;
    }
    if (result.clientHeight === height) return;
    height = result.clientHeight;
    refill();
  });
  observer.observe(result);
  onAbort(signal, () => observer.disconnect());
  return {
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

// Windowed rendering: the run's header, a scroll node in which only the rows near the viewport get
// DOM nodes (spacer divs hold the scroll height), and its footer. Materializing every row (100k at
// max solver settings) costs seconds of main-thread time per render.
const VIRTUAL_OVERSCAN_ROWS = 20;
// Returns the mounted run, or null when it has no rows (a note says so), so a panel that changes
// height can re-window without a full re-render, and the next run (a rotation step's, dozens of
// times a second) can take over the nodes already there instead of rebuilding them.
export function mountVirtualRows(result: HTMLElement, view: VirtualView): VirtualRows | null {
  const header = rowEl({ kind: "header", text: view.header });
  const sc = el("div", { className: "iterate-scroll" });
  const footer = rowEl({ kind: "footer", text: view.footer });
  result.append(header, sc, footer);
  if (view.rows.length === 0) {
    sc.append(el("div", { className: "iterate-item-nohover", text: "No iterations available." }));
    return null;
  }
  const topSpacer = el("div");
  const rowsEl = el("div", { className: "iterate-rows" });
  const bottomSpacer = el("div");
  sc.append(el("div", { className: "iterate-virtual-wrapper" }, [topSpacer, rowsEl, bottomSpacer]));

  let blocks = view.rows;
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
    show: (next, remeasure) => {
      header.textContent = next.header;
      footer.textContent = next.footer;
      blocks = next.rows;
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
