import type { State } from "@/features/core/store";
import type { ResultTextBlock } from "@/features/solver/types";
import { el } from "@/ui/dom";

export const rowEl = (block: ResultTextBlock) => el("div", { className: block.className, text: block.text, attrs: block.index !== undefined ? { "data-index": String(block.index) } : {} });

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

// Sizes the result's font to fit the widest line in its width.
// The horizontal padding is static CSS; reading computed style per render
// (interleaved with the DOM writes below) forced a layout pass per solve
// result and per rotation step.
export function createResultFit(result: HTMLElement) {
  let cachedPadding: number | null = null;
  let lastFitKey = "";
  return function fit(s: State) {
    if (s.resultMaxLineChars > 0) {
      if (cachedPadding === null) {
        const containerStyle = window.getComputedStyle(result);
        cachedPadding = (parseFloat(containerStyle.paddingLeft) || 0) + (parseFloat(containerStyle.paddingRight) || 0);
      }
      const effectiveWidth = result.clientWidth - cachedPadding;
      const fitKey = `${s.resultMaxLineChars}|${effectiveWidth}`;
      if (fitKey === lastFitKey) return;
      lastFitKey = fitKey;
      if (effectiveWidth > 0) {
        const targetWidth = Math.max(1, effectiveWidth - FIT_SLACK_PX);
        const maxLineWidth = s.resultMaxLineChars * BASE_FONT_PX * GLYPH_WIDTH_EM;
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
  };
}

// Windowed rendering: only the rows near the viewport get DOM nodes, with
// spacer divs holding the scroll height. Materializing every row (100k at
// max solver settings) costs seconds of main-thread time per render.
const VIRTUAL_OVERSCAN_ROWS = 20;
// Returns the window refill (null without rows), so a panel that changes
// height can re-window without a full re-render.
export function mountVirtualRows(sc: HTMLElement, blocks: State["resultVirtualRows"], result: HTMLElement): (() => void) | null {
  const topSpacer = el("div");
  const rowsEl = el("div", { className: "iterate-rows" });
  const bottomSpacer = el("div");
  sc.append(el("div", { className: "iterate-virtual-wrapper" }, [topSpacer, rowsEl, bottomSpacer]));
  if (blocks.length === 0) return null;

  let rowHeight = 0;
  let windowStart = -1;
  let windowEnd = -1;
  const fillWindow = () => {
    if (rowHeight <= 0) {
      const first = blocks.at(0)!;
      const probe = el("div", {
        className: first.className,
        text: first.text,
      });
      rowsEl.append(probe);
      rowHeight = probe.offsetHeight || FALLBACK_ROW_HEIGHT_PX;
      probe.remove();
    }
    const viewHeight = sc.clientHeight || result.clientHeight || FALLBACK_VIEW_HEIGHT_PX;
    const start = Math.max(0, Math.floor(sc.scrollTop / rowHeight) - VIRTUAL_OVERSCAN_ROWS);
    const end = Math.min(blocks.length, Math.ceil((sc.scrollTop + viewHeight) / rowHeight) + VIRTUAL_OVERSCAN_ROWS);
    if (start === windowStart && end === windowEnd) return;
    windowStart = start;
    windowEnd = end;
    topSpacer.style.height = `${start * rowHeight}px`;
    bottomSpacer.style.height = `${(blocks.length - end) * rowHeight}px`;
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) fragment.append(rowEl(blocks.at(i)!));
    rowsEl.replaceChildren(fragment);
  };

  let scrollRafId: number | null = null;
  sc.addEventListener(
    "scroll",
    () => {
      if (scrollRafId !== null) return;
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = null;
        fillWindow();
      });
    },
    { passive: true },
  );
  fillWindow();
  return fillWindow;
}

// The panel is resized independently of its contents (sidebar handle, log
// expansion). A width change needs the full re-render, since fit() sizes the
// font to the width; a height change only needs the virtual window refilled,
// which matters because expanding the log emits a stream of height changes.
export function observeResultSize(result: HTMLElement, { onWidthChange, onHeightChange }: { onWidthChange: () => void; onHeightChange: () => void }) {
  let fittedWidth = result.clientWidth;
  let fittedHeight = result.clientHeight;
  const sizeObserver = new ResizeObserver(() => {
    const width = result.clientWidth;
    const height = result.clientHeight;
    if (width !== fittedWidth) {
      fittedWidth = width;
      fittedHeight = height;
      onWidthChange();
      return;
    }
    if (height === fittedHeight) return;
    fittedHeight = height;
    onHeightChange();
  });
  sizeObserver.observe(result);
  return sizeObserver;
}
