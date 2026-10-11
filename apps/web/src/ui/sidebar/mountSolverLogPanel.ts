import { DRAWING_PHASE_KEYS } from "@/features/problem/selectors";
import type { AppActions } from "@/app/appActions";
import { onAbort } from "@/features/core/lifetime";
import { getState, on, type State } from "@/features/core/store";
import { el } from "@/ui/dom";
import { renderOn } from "@/ui/renderOn";
import { desktopNote, usageHint } from "@/ui/usageTips";
import { createSolverLogHover } from "./solverLogHover";
import { createResultFit, mountVirtualRows, rowEl, type VirtualRows } from "./solverLogVirtualRows";

export function mountSolverLogPanel(parent: HTMLElement, actions: Pick<AppActions, "setIterateHighlight" | "finishOpenRegion">, signal: AbortSignal) {
  const frame = el("div", { id: "terminal-container" });
  const result = el("div", { id: "result" });
  frame.append(result, el("div", { id: "terminal-window" }));
  parent.append(frame);
  const hover = createSolverLogHover(result, (index) => actions.setIterateHighlight(index));
  // the virtualized run while one is mounted: re-windowed when the panel's height changes, and
  // the next run's result (a rotation step's) shown in the nodes already there
  let virtual: VirtualRows | null = null;
  const { fit } = createResultFit(result, { rerender: () => render(getState()), refill: () => virtual?.refill() }, signal);

  function render(state: State) {
    const view = state.result;
    const refit = fit(view.kind === "usage" ? 0 : view.maxLineChars);
    hover.forgetHoveredRow();
    if (view.kind === "virtual" && virtual && view.rows.length > 0) {
      virtual.show(view, refit);
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
    virtual = mountVirtualRows(result, view);
    hover.scheduleHoverSync();
  }
  renderOn(["result"], render, signal);

  // The placeholder hint reflects the current drawing phase, so refresh it as
  // the user sketches — but only while the panel is showing that hint, never
  // while a (potentially huge) solver result is mounted.
  on(
    DRAWING_PHASE_KEYS,
    () => {
      const state = getState();
      if (state.result.kind === "usage") render(state);
    },
    signal,
  );
  onAbort(signal, hover.clearHoverState);
  return { root: frame };
}
