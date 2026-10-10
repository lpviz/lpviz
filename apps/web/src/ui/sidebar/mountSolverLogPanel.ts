import type { AppContext } from "@/app/appContext";
import { computeDrawingPhase, getState, on, type State } from "@/features/core/store";
import { el } from "@/ui/dom";
import { usageHint } from "@/ui/usageTips";
import { createSolverLogHover } from "./solverLogHover";
import { createResultFit, mountVirtualRows, observeResultSize, rowEl } from "./solverLogVirtualRows";

export function mountSolverLogPanel(parent: HTMLElement, ctx: AppContext) {
  const frame = el("div", { id: "terminal-container" });
  const result = el("div", { id: "result" });
  frame.append(result, el("div", { id: "terminal-window" }));
  parent.append(frame);
  const hover = createSolverLogHover(result, (index) => ctx.actions.setIterateHighlight(index));
  const fit = createResultFit(result);
  // Set while a virtualized result is mounted, so a panel that changes height
  // can re-window without a full re-render (see the size observer below).
  let refillVirtualWindow: (() => void) | null = null;

  function render(s: State) {
    // fit() reads layout (clientWidth); keep it ahead of the DOM writes below
    fit(s);
    refillVirtualWindow = null;
    result.className = s.resultDisplayMode === "virtual" ? "virtualized" : "";
    result.replaceChildren();
    hover.forgetHoveredRow();
    if (s.resultDisplayMode === "usage") {
      result.append(usageHint(computeDrawingPhase(s)));
      return;
    }
    if (s.resultDisplayMode === "blocks" && s.resultBlocks) {
      result.append(el("div", {}, s.resultBlocks.map(rowEl)));
      return;
    }
    if (s.resultDisplayMode === "virtual") {
      result.append(
        el("div", {
          className: "iterate-header",
          text: s.resultVirtualHeader ?? "",
        }),
      );
      const sc = el("div", { className: "iterate-scroll" });
      result.append(
        sc,
        el("div", {
          className: "iterate-footer",
          text: s.resultVirtualFooter ?? "",
        }),
      );
      if (s.resultVirtualShowEmpty)
        sc.append(
          el("div", {
            className: "iterate-item-nohover",
            text: "No iterations available.",
          }),
        );
      else refillVirtualWindow = mountVirtualRows(sc, s.resultVirtualRows, result);
    }
    hover.scheduleHoverSync();
  }
  render(getState());

  const sizeObserver = observeResultSize(result, {
    onWidthChange: () => render(getState()),
    onHeightChange: () => refillVirtualWindow?.(),
  });

  const controller = new AbortController();
  on(
    ["resultDisplayMode", "resultBlocks", "resultVirtualHeader", "resultVirtualFooter", "resultVirtualShowEmpty", "resultVirtualRows", "resultMaxLineChars"],
    () => render(getState()),
    controller.signal,
  );
  // The placeholder hint reflects the current drawing phase, so refresh it as
  // the user sketches — but only while the panel is showing that hint, never
  // while a (potentially huge) solver result is mounted.
  on(
    ["vertices", "completionMode", "objectiveVector", "currentObjective"],
    () => {
      const s = getState();
      if (s.resultDisplayMode === "usage") render(s);
    },
    controller.signal,
  );
  return {
    root: frame,
    destroy: () => {
      controller.abort();
      sizeObserver.disconnect();
      hover.clearHoverState();
      frame.remove();
    },
  };
}
