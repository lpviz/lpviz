import type { AppContext } from "@/app/appContext";
import { getState, on, type State } from "@/features/core/store";
import { el } from "@/ui/dom";
import { renderOn } from "@/ui/renderOn";
import { desktopNote, usageHint } from "@/ui/usageTips";
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
    const view = s.result;
    // fit() reads layout (clientWidth); keep it ahead of the DOM writes below
    fit(view.kind === "usage" ? 0 : view.maxLineChars);
    refillVirtualWindow = null;
    result.className = view.kind === "virtual" ? "virtualized" : "";
    result.replaceChildren();
    hover.forgetHoveredRow();
    if (view.kind === "usage") {
      result.append(usageHint(s, ctx.actions.finishOpenRegion), desktopNote());
      return;
    }
    if (view.kind === "blocks") {
      result.append(el("div", {}, view.blocks.map(rowEl)));
      return;
    }
    result.append(el("div", { className: "iterate-header", text: view.header }));
    const sc = el("div", { className: "iterate-scroll" });
    result.append(sc, el("div", { className: "iterate-footer", text: view.footer ?? "" }));
    if (view.rows.length === 0) sc.append(el("div", { className: "iterate-item-nohover", text: "No iterations available." }));
    else refillVirtualWindow = mountVirtualRows(sc, view.rows, result);
    hover.scheduleHoverSync();
  }
  const stopRender = renderOn(["result"], render);

  const sizeObserver = observeResultSize(result, {
    onWidthChange: () => render(getState()),
    onHeightChange: () => refillVirtualWindow?.(),
  });

  // The placeholder hint reflects the current drawing phase, so refresh it as
  // the user sketches — but only while the panel is showing that hint, never
  // while a (potentially huge) solver result is mounted.
  const hintSync = new AbortController();
  on(
    ["vertices", "completionMode", "objectiveVector", "currentObjective"],
    () => {
      const s = getState();
      if (s.result.kind === "usage") render(s);
    },
    hintSync.signal,
  );
  return {
    root: frame,
    destroy: () => {
      hintSync.abort();
      stopRender();
      sizeObserver.disconnect();
      hover.clearHoverState();
      frame.remove();
    },
  };
}
