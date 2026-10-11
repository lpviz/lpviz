import { DRAWING_PHASE_KEYS } from "@/features/problem/selectors";
import type { AppActions } from "@/app/appActions";
import { getState, on, type State } from "@/features/core/store";
import { el } from "@/ui/dom";
import { renderOn } from "@/ui/renderOn";
import { desktopNote, usageHint } from "@/ui/usageTips";
import { createSolverLogHover } from "./solverLogHover";
import { createResultFit, mountVirtualRows, observeResultSize, rowEl, type VirtualRows } from "./solverLogVirtualRows";

export function mountSolverLogPanel(parent: HTMLElement, actions: Pick<AppActions, "setIterateHighlight" | "finishOpenRegion">) {
  const frame = el("div", { id: "terminal-container" });
  const result = el("div", { id: "result" });
  frame.append(result, el("div", { id: "terminal-window" }));
  parent.append(frame);
  const hover = createSolverLogHover(result, (index) => actions.setIterateHighlight(index));
  const { fit, setWidth } = createResultFit(result);
  // The virtualized result while one is mounted: its header and footer lines and its rows, so a
  // panel that changes height can re-window without a full re-render (see the size observer
  // below), and the next run's result (a rotation step's) can be shown in the nodes already there.
  let virtual: { header: HTMLElement; footer: HTMLElement; rows: VirtualRows } | null = null;

  function render(state: State) {
    const view = state.result;
    const refit = fit(view.kind === "usage" ? 0 : view.maxLineChars);
    hover.forgetHoveredRow();
    if (view.kind === "virtual" && virtual && view.rows.length > 0) {
      virtual.header.textContent = view.header;
      virtual.footer.textContent = view.footer;
      virtual.rows.update(view.rows, refit);
      hover.scheduleHoverSync();
      return;
    }
    virtual = null;
    result.classList.toggle("virtualized", view.kind === "virtual");
    result.replaceChildren();
    if (view.kind === "usage") {
      result.append(usageHint(state, actions.finishOpenRegion), desktopNote());
      return;
    }
    if (view.kind === "blocks") {
      result.append(el("div", {}, view.blocks.map(rowEl)));
      return;
    }
    const header = el("div", { className: "iterate-header", text: view.header });
    const sc = el("div", { className: "iterate-scroll" });
    const footer = el("div", { className: "iterate-footer", text: view.footer });
    result.append(header, sc, footer);
    if (view.rows.length === 0) sc.append(el("div", { className: "iterate-item-nohover", text: "No iterations available." }));
    else {
      const rows = mountVirtualRows(sc, view.rows, result);
      if (rows) virtual = { header, footer, rows };
    }
    hover.scheduleHoverSync();
  }
  const stopRender = renderOn(["result"], render);

  const sizeObserver = observeResultSize(result, {
    onWidthChange: (width) => {
      setWidth(width);
      render(getState());
    },
    onHeightChange: () => virtual?.rows.refill(),
  });

  // The placeholder hint reflects the current drawing phase, so refresh it as
  // the user sketches — but only while the panel is showing that hint, never
  // while a (potentially huge) solver result is mounted.
  const hintSync = new AbortController();
  on(
    DRAWING_PHASE_KEYS,
    () => {
      const state = getState();
      if (state.result.kind === "usage") render(state);
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
